use super::*;
use std::io::Write;
use std::sync::atomic::AtomicUsize;
type Entries = Arc<Mutex<HashMap<String, (Value, Vec<u8>)>>>;
struct Memory {
    entries: Entries,
    reads: Arc<AtomicUsize>,
}
impl Memory {
    fn new() -> Self {
        let entries = HashMap::from([
            (
                "".into(),
                (
                    json!({"id":"root","name":"CNote","folder":{},"eTag":"\"root\""}),
                    vec![],
                ),
            ),
            (
                "中文 & file.txt".into(),
                (
                    json!({"id":"file","name":"中文 & file.txt","size":5,"eTag":"\"original\""}),
                    b"hello".to_vec(),
                ),
            ),
        ]);
        Self {
            entries: Arc::new(Mutex::new(entries)),
            reads: Arc::new(AtomicUsize::new(0)),
        }
    }
}
impl Drive for Memory {
    fn authorized(&mut self) -> bool {
        true
    }
    fn metadata(&mut self, path: &str) -> DavResult<Value> {
        self.entries
            .lock()
            .unwrap()
            .get(path)
            .map(|(v, _)| v.clone())
            .ok_or(Failure(404, "Missing"))
    }
    fn children(&mut self, path: &str) -> DavResult<Vec<Value>> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| {
                !key.is_empty() && key.rsplit_once('/').map(|(p, _)| p).unwrap_or("") == path
            })
            .map(|(_, (v, _))| v.clone())
            .collect())
    }
    fn download(&mut self, path: &str) -> DavResult<File> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let entries = self.entries.lock().unwrap();
        let (_, bytes) = entries.get(path).ok_or(Failure(404, "Missing"))?;
        let mut file = tempfile::tempfile()?;
        file.write_all(bytes)?;
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
    fn upload(&mut self, path: &str, mut file: File, version: Option<&str>) -> DavResult<Value> {
        let mut entries = self.entries.lock().unwrap();
        if let Some((old, _)) = entries.get(path)
            && old["eTag"].as_str() != version
        {
            return Err(Failure(412, "Conflict"));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let value = json!({"id":path,"name":path.rsplit('/').next().unwrap(),"size":bytes.len(),"eTag":format!("\"{}\"",uuid::Uuid::new_v4())});
        entries.insert(path.into(), (value.clone(), bytes));
        Ok(value)
    }
    fn mkdir(&mut self, path: &str) -> DavResult<Value> {
        let mut entries = self.entries.lock().unwrap();
        if entries.contains_key(path) {
            return Err(Failure(409, "Exists"));
        }
        let value = json!({"id":path,"name":path.rsplit('/').next().unwrap(),"folder":{},"eTag":"\"folder\""});
        entries.insert(path.into(), (value.clone(), vec![]));
        Ok(value)
    }
    fn delete(&mut self, path: &str, version: &str) -> DavResult<()> {
        let mut entries = self.entries.lock().unwrap();
        if entries.get(path).and_then(|(v, _)| v["eTag"].as_str()) != Some(version) {
            return Err(Failure(412, "Conflict"));
        }
        entries.retain(|p, _| p != path && !p.starts_with(&format!("{path}/")));
        Ok(())
    }
    fn move_item(&mut self, path: &str, target: &str, version: &str) -> DavResult<Value> {
        let mut entries = self.entries.lock().unwrap();
        if entries.get(path).and_then(|(v, _)| v["eTag"].as_str()) != Some(version) {
            return Err(Failure(412, "Conflict"));
        }
        let (mut value, bytes) = entries.remove(path).ok_or(Failure(404, "Missing"))?;
        value["name"] = json!(target.rsplit('/').next().unwrap());
        entries.insert(target.into(), (value.clone(), bytes));
        Ok(value)
    }
}
#[test]
fn dav_authentication_lazy_reads_changes_and_conflicts() {
    let memory = Memory::new();
    let entries = memory.entries.clone();
    let reads = memory.reads.clone();
    let (bridge, port) = launch(Box::new(memory)).unwrap();
    let client = Client::builder().no_proxy().build().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let req = |method: &str, path: &str| {
        client
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{base}{path}"),
            )
            .basic_auth("cnote", Some(&bridge.password))
    };
    assert_eq!(
        client
            .get(format!("{base}/CNote/"))
            .send()
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    assert_eq!(
        req("PROPFIND", "/CNote/")
            .header("Origin", "https://evil.example")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    let response = req("PROPFIND", "/CNote/")
        .header("Depth", "1")
        .send()
        .unwrap();
    assert_eq!(response.status().as_u16(), 207);
    let text = response.text().unwrap();
    assert!(text.contains("中文 &amp; file.txt"));
    assert!(text.contains("%E4%B8%AD%E6%96%87"));
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    let encoded = href("中文 & file.txt", false);
    assert_eq!(
        req("GET", &encoded).send().unwrap().text().unwrap(),
        "hello"
    );
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        req("PUT", &encoded)
            .body("updated")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        204
    );
    entries
        .lock()
        .unwrap()
        .get_mut("中文 & file.txt")
        .unwrap()
        .0["eTag"] = json!("\"remote-change\"");
    assert_eq!(
        req("PUT", &encoded)
            .body("stale")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        412
    );
    assert_eq!(
        req("MKCOL", "/CNote/folder")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        201
    );
    assert_eq!(
        req("PUT", "/CNote/new.txt")
            .body("new")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        201
    );
    assert_eq!(
        req("MOVE", "/CNote/new.txt")
            .header("Destination", format!("{base}/CNote/folder/moved.txt"))
            .header("Overwrite", "F")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        201
    );
    assert_eq!(
        req("GET", "/CNote/folder/moved.txt")
            .header("Range", "bytes=1-2")
            .send()
            .unwrap()
            .text()
            .unwrap(),
        "ew"
    );
    assert_eq!(
        req("MOVE", "/CNote/folder/moved.txt")
            .header("Destination", "http://evil.example/CNote/x")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        403
    );
    assert_eq!(
        req("DELETE", "/CNote/folder/moved.txt")
            .send()
            .unwrap()
            .status()
            .as_u16(),
        204
    );
    for path in ["/CNote/%2Fetc", "/CNote/%00a", "/CNote/%5Cetc"] {
        assert_eq!(req("GET", path).send().unwrap().status().as_u16(), 403);
    }
    bridge.valid.store(false, Ordering::SeqCst);
    assert_eq!(req("GET", &encoded).send().unwrap().status().as_u16(), 503);
    bridge.stop.store(true, Ordering::SeqCst);
}
#[test]
#[ignore = "Mounts an isolated mock DAV volume in Finder; requires a graphical macOS session"]
fn native_finder_lazy_mount() {
    let memory = Memory::new();
    let entries = memory.entries.clone();
    let reads = memory.reads.clone();
    let (bridge, port) = launch(Box::new(memory)).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("CNote");
    std::fs::create_dir(&path).unwrap();
    struct Cleanup {
        path: PathBuf,
        bridge: Arc<Bridge>,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::process::Command::new("/sbin/umount")
                .arg(&self.path)
                .status();
            self.bridge.stop.store(true, Ordering::SeqCst);
        }
    }
    let _cleanup = Cleanup {
        path: path.clone(),
        bridge: bridge.clone(),
    };
    eprintln!("Native mount: connecting");
    mount_volume(port, &path, &bridge.password).unwrap();
    eprintln!("Native mount: listing");
    assert!(is_mounted(&path));
    let files = std::fs::read_dir(&path)
        .unwrap()
        .map(|r| r.unwrap().file_name())
        .collect::<Vec<_>>();
    assert!(files.contains(&std::ffi::OsString::from("中文 & file.txt")));
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "Directory enumeration must not download file content"
    );
    assert_eq!(
        std::fs::read(path.join("中文 & file.txt")).unwrap(),
        b"hello"
    );
    eprintln!("Native mount: writing");
    let mut file = File::create(path.join("new.txt")).unwrap();
    file.write_all(b"native upload").unwrap();
    let _ = file.sync_all(); // webdavfs does not implement fsync on every macOS release.
    drop(file);
    let until = Instant::now() + Duration::from_secs(10);
    while !entries.lock().unwrap().contains_key("new.txt") && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        entries.lock().unwrap().get("new.txt").unwrap().1,
        b"native upload"
    );
    eprintln!("Native mount: renaming");
    std::fs::rename(path.join("new.txt"), path.join("renamed.txt")).unwrap();
    assert_eq!(
        std::fs::read(path.join("renamed.txt")).unwrap(),
        b"native upload"
    );
    std::fs::remove_file(path.join("renamed.txt")).unwrap();
    std::fs::create_dir(path.join("new folder")).unwrap();
    std::fs::remove_dir(path.join("new folder")).unwrap();
    println!("Finder mount: lazy enumeration, read, write, rename, delete and folders passed");
}

#[test]
fn range_requests_and_finder_metadata_stay_local() {
    assert_eq!(byte_range(Some("bytes=-2"), 5).unwrap(), (3, 4, true));
    assert_eq!(byte_range(Some("bytes=1-999"), 5).unwrap(), (1, 4, true));
    assert!(byte_range(Some("bytes=6-"), 5).is_err());
    assert!(byte_range(Some("bytes=0-"), 0).is_err());
    let dir = tempfile::tempdir().unwrap();
    let mut drive = graph::GraphDrive {
        cloud: Cloud {
            client: Client::new(),
            tokens: None,
        },
        account: "mock".into(),
        metadata_directory: dir.path().to_owned(),
    };
    let mut bytes = tempfile::tempfile().unwrap();
    bytes.write_all(b"Finder preferences").unwrap();
    bytes.rewind().unwrap();
    let item = drive.upload("Pictures/.DS_Store", bytes, None).unwrap();
    let mut text = String::new();
    drive
        .download("Pictures/.DS_Store")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "Finder preferences");
    drive
        .move_item(
            "Pictures/.DS_Store",
            "Photos/.DS_Store",
            item["eTag"].as_str().unwrap(),
        )
        .unwrap();
    let item = drive.metadata("Photos/.DS_Store").unwrap();
    drive
        .delete("Photos/.DS_Store", item["eTag"].as_str().unwrap())
        .unwrap();
    assert!(drive.metadata("Photos/.DS_Store").is_err());
}
