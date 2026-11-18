//! Lift uneven paper illumination and darken faint pencil before arithmetic OCR.
//! Only pixels are transformed: no recognition, generated strokes or answer inference.
use anyhow::{Context, Result};
use image::{DynamicImage, GrayImage, ImageDecoder, ImageFormat, ImageReader};
use std::io::Cursor;

pub(super) fn enhance(bytes: &[u8]) -> Result<Vec<u8>> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .context("无法读取口算图片格式")?;
    let mut decoder = reader.into_decoder().context("无法解码口算图片")?;
    let (width, height) = decoder.dimensions();
    anyhow::ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= 40_000_000,
        "口算图片超过4000万像素"
    );
    let orientation = decoder.orientation().context("无法读取图片方向")?;
    let mut decoded = DynamicImage::from_decoder(decoder).context("无法解码口算图片")?;
    decoded.apply_orientation(orientation);
    // Composite transparency onto white paper before estimating its background.
    let alpha = decoded.into_luma_alpha8();
    let mut gray = GrayImage::new(alpha.width(), alpha.height());
    for (output, input) in gray.pixels_mut().zip(alpha.pixels()) {
        output[0] = ((u32::from(input[0]) * u32::from(input[1])
            + 255 * (255 - u32::from(input[1])))
            / 255) as u8;
    }
    // Suppress fine paper grain before the stronger black point amplifies it.
    let mut gray = image::imageops::blur(&gray, 0.6);
    darken_pencil(&mut gray);
    deepen_ink(&mut gray);
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageLuma8(gray)
        .write_to(&mut output, ImageFormat::Png)
        .context("无法保存增强后的口算图片")?;
    Ok(output.into_inner())
}

fn darken_pencil(gray: &mut GrayImage) {
    let (width, height) = (gray.width() as usize, gray.height() as usize);
    // Scale the neighbourhood with photo resolution, without resizing handwriting.
    let radius = (width.min(height) / 50).clamp(8, 80);
    let mut horizontal = vec![0_u8; width * height];
    for y in 0..height {
        let row = &gray.as_raw()[y * width..(y + 1) * width];
        let mut sum: u32 = row[..radius.min(width - 1) + 1]
            .iter()
            .map(|&v| u32::from(v))
            .sum();
        for x in 0..width {
            let left = x.saturating_sub(radius);
            let right = (x + radius + 1).min(width);
            horizontal[y * width + x] = (sum / (right - left) as u32) as u8;
            if x >= radius {
                sum -= u32::from(row[x - radius]);
            }
            if x + radius + 1 < width {
                sum += u32::from(row[x + radius + 1]);
            }
        }
    }
    for x in 0..width {
        let mut sum: u32 = (0..=radius.min(height - 1))
            .map(|y| u32::from(horizontal[y * width + x]))
            .sum();
        for y in 0..height {
            let top = y.saturating_sub(radius);
            let bottom = (y + radius + 1).min(height);
            let background = (sum / (bottom - top) as u32) as u8;
            let pixel = &mut gray.as_mut()[y * width + x];
            // A small noise floor keeps paper grain from becoming black speckles.
            // Normalize first; a global threshold on the photo would darken shadows too.
            *pixel = 255
                - u16::from(background.saturating_sub(*pixel).saturating_sub(3))
                    .saturating_mul(6)
                    .min(255) as u8;
            if y >= radius {
                sum -= u32::from(horizontal[(y - radius) * width + x]);
            }
            if y + radius + 1 < height {
                sum += u32::from(horizontal[(y + radius + 1) * width + x]);
            }
        }
    }
}

fn deepen_ink(gray: &mut GrayImage) {
    // Adapted from cyeam_web/views/mo/old_chinese.html's otsuThreshold and
    // processImageToCanvas: choose an ink/background split, then make ink solid while retaining faint edge detail.
    let mut histogram = [0_u64; 256];
    for &pixel in gray.as_raw() {
        histogram[pixel as usize] += 1;
    }
    let total = gray.as_raw().len() as u64;
    let sum: u64 = histogram
        .iter()
        .enumerate()
        .map(|(i, &n)| i as u64 * n)
        .sum();
    let (mut weight, mut partial_sum, mut best, mut split) = (0_u64, 0_u64, 0.0, 0_u16);
    for (tone, &count) in histogram.iter().enumerate() {
        weight += count;
        partial_sum += tone as u64 * count;
        let remaining = total - weight;
        if weight == 0 || remaining == 0 {
            continue;
        }
        let difference =
            partial_sum as f64 / weight as f64 - (sum - partial_sum) as f64 / remaining as f64;
        let variance = weight as f64 * remaining as f64 * difference * difference;
        if variance > best {
            best = variance;
            split = tone as u16 + 1;
        }
    }
    // Dark headings/grid lines otherwise dominate Otsu and discard faint pencil.
    // After illumination correction, near-white paper stays above this range.
    let threshold = split.clamp(200, 220) as u8;
    for pixel in gray.as_mut() {
        // A hard white cutoff lost faint handwriting in the live OCR comparison.
        // Use Otsu's foreground split as a black point and retain the pale tail.
        *pixel =
            (u16::from(pixel.saturating_sub(threshold)) * 255 / u16::from(255 - threshold)) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn faint_strokes_gain_contrast_on_both_lit_and_shadowed_paper() {
        let mut paper = GrayImage::from_fn(240, 160, |x, _| image::Luma([160 + (x / 4) as u8]));
        for x in [40, 200] {
            for y in 20..140 {
                paper.get_pixel_mut(x, y)[0] -= 20;
            }
        }
        darken_pencil(&mut paper);
        for x in [40, 200] {
            assert!(
                paper.get_pixel(x + 4, 80)[0] >= 249,
                "paper should be white"
            );
            assert!(
                paper.get_pixel(x, 80)[0] <= 165,
                "faint strokes should darken"
            );
        }
    }

    #[test]
    fn blank_paper_and_small_images_do_not_acquire_marks() {
        for (width, height) in [(1, 1), (2, 90), (90, 2), (100, 100)] {
            let mut paper = GrayImage::from_pixel(width, height, image::Luma([170]));
            darken_pencil(&mut paper);
            deepen_ink(&mut paper);
            assert!(paper.as_raw().iter().all(|&v| v == 255));
        }
        assert!(enhance(b"invalid image").is_err());
    }

    #[test]
    fn solid_black_ink_keeps_faint_pencil_even_beside_dark_grid_lines() {
        let mut paper = GrayImage::from_pixel(240, 160, image::Luma([200]));
        for y in 0..160 {
            paper.get_pixel_mut(120, y)[0] = 30;
        }
        for y in 20..140 {
            paper.get_pixel_mut(40, y)[0] = 185;
        }
        darken_pencil(&mut paper);
        deepen_ink(&mut paper);
        assert_eq!(paper.get_pixel(40, 80)[0], 0);
        assert_eq!(paper.get_pixel(120, 80)[0], 0);
        assert_eq!(paper.get_pixel(80, 80)[0], 255);
        let mut edge = GrayImage::from_raw(3, 1, vec![160, 235, 255]).unwrap();
        deepen_ink(&mut edge);
        assert_eq!(edge.get_pixel(0, 0)[0], 0);
        assert!(edge.get_pixel(1, 0)[0] > 0 && edge.get_pixel(1, 0)[0] < 235);
        assert_eq!(edge.get_pixel(2, 0)[0], 255);
    }

    // Opt-in inspection uses the production transform on local photos without networking.
    #[test]
    #[ignore]
    fn preview_local_photos() {
        for path in std::env::var("CNOTE_PENCIL_PHOTOS").unwrap().split(':') {
            let output = enhance(&std::fs::read(path).unwrap()).unwrap();
            std::fs::write(format!("{path}.enhanced.png"), output).unwrap();
        }
    }
}
