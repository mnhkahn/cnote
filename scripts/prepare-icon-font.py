#!/usr/bin/env python3
"""Add GPUI's required metrics glyph to a regenerated Bootstrap Icons TTF.

Run manually with fonttools installed; builds use the checked-in font directly.
The editor's WOFF2 and all original icon outlines/codepoints remain unchanged.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen

path = Path(__file__).resolve().parent.parent / 'assets/bootstrap-icons.ttf'
font = TTFont(path, recalcTimestamp=False)
if ord('m') not in font.getBestCmap():
    name = 'cnote.metrics.m'
    em = font['head'].unitsPerEm
    pen = TTGlyphPen(None)
    # This glyph is only used for GPUI em measurements, never for visible text.
    pen.moveTo((0, 0))
    pen.lineTo((round(em * .8), 0))
    pen.lineTo((round(em * .8), round(em * .75)))
    pen.lineTo((0, round(em * .75)))
    pen.closePath()
    font.setGlyphOrder(font.getGlyphOrder() + [name])
    font['glyf'][name] = pen.glyph()
    font['hmtx'].metrics[name] = (em, 0)
    for table in font['cmap'].tables:
        if table.isUnicode():
            table.cmap[ord('m')] = name
    font.save(path)
    print('Added GPUI metrics glyph; original icon mappings preserved.')
else:
    print('GPUI metrics glyph already present.')
