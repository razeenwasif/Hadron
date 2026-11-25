//! Headless Neutron file engine, fuzzy finder, archives, and remote SFTP/FTP bridge.

pub mod engine;
pub mod types;

pub use engine::{neutron_data_dir, NeutronEngine};
pub use types::*;

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("flux-neutron-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn lists_and_sorts_entries_preserving_dirs_first() {
        let root = temp_dir("list");
        fs::create_dir(root.join("alpha_dir")).unwrap();
        fs::write(root.join("b_big.txt"), b"hello world!").unwrap();
        fs::write(root.join("a_small.txt"), b"hi").unwrap();
        fs::write(root.join(".hidden"), b"secret").unwrap();

        let eng = NeutronEngine::new();
        let listing = eng
            .list_dir(
                root.to_str().unwrap(),
                ListOptions {
                    sort_by: SortBy::Size,
                    sort_dir: SortDir::Asc,
                    dirs_first: true,
                    show_hidden: false,
                    filter: String::new(),
                },
            )
            .unwrap();

        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha_dir", "a_small.txt", "b_big.txt"]);
        assert_eq!(listing.hidden_count, 1);

        let all = eng
            .list_dir(
                root.to_str().unwrap(),
                ListOptions {
                    show_hidden: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(all.entries.iter().any(|e| e.name == ".hidden"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fuzzy_search_finds_nested_files_with_positions() {
        let root = temp_dir("fuzzy");
        fs::create_dir_all(root.join("src/ui")).unwrap();
        fs::write(root.join("src/ui/SidebarView.tsx"), b"export {}").unwrap();
        fs::write(root.join("README.md"), b"readme").unwrap();

        let eng = NeutronEngine::new();
        let hits = eng.fuzzy_search(root.to_str().unwrap(), "sbv", 10).unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].name, "SidebarView.tsx");
        assert!(!hits[0].positions.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_mkdir_rename_undo_and_archive_roundtrip() {
        let root = temp_dir("ops");
        let eng = NeutronEngine::new();

        let folder = eng.mkdir(root.to_str().unwrap(), "docs").unwrap();
        let file = eng.create_file(&folder, "note.txt").unwrap();
        fs::write(&file, b"flux + neutron").unwrap();

        let prev = eng.preview(&file).unwrap();
        assert_eq!(prev.kind, "text");
        assert_eq!(prev.text.as_deref(), Some("flux + neutron"));

        let renamed = eng.rename(&file, "notes.txt").unwrap();
        assert!(std::path::Path::new(&renamed).exists());
        let _ = eng.undo().unwrap();
        assert!(std::path::Path::new(&file).exists());

        let zip_res = eng
            .archive_create(
                std::slice::from_ref(&folder),
                Some(root.join("bundle.zip").to_str().unwrap()),
            )
            .unwrap();
        assert_eq!(zip_res.files, 1);

        let arch_list = eng
            .list_dir(
                &format!("archive://{}!docs", zip_res.destination),
                ListOptions::default(),
            )
            .unwrap();
        assert_eq!(arch_list.scheme, "archive");
        assert_eq!(arch_list.entries[0].name, "note.txt");

        let extract_dir = root.join("unpacked");
        let ex_res = eng
            .archive_extract(&zip_res.destination, Some(extract_dir.to_str().unwrap()))
            .unwrap();
        assert_eq!(ex_res.files, 1);
        assert_eq!(
            fs::read_to_string(extract_dir.join("docs/note.txt")).unwrap(),
            "flux + neutron"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
