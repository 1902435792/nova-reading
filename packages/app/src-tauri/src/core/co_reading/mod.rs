pub mod commands;
pub mod models;
pub mod range;

#[cfg(test)]
mod tests {
    use super::commands::{
        claim_blocks, complete_batch, get_snapshot, persist_focus, queued_blocks, release_focus,
        retry_blocks, update_settings, upsert_blocks,
    };
    use super::models::{
        AdvanceCoReadingRangeTaskData, ClaimCoReadingBlocksData, CoReadingBlockUpsert,
        CoReadingFootprintUpsert, CoReadingNoteCreateData, CompleteCoReadingBatchData,
        CreateCoReadingRangeTaskData, FailCoReadingRangeSectionData, PersistCoReadingFocusData,
        PersistCoReadingRangeSectionData, ReleaseCoReadingFocusData, RetryCoReadingBlocksData,
        UpdateCoReadingRangeTaskData, UpdateCoReadingSettingsData,
    };
    use super::range::{
        advance_task, create_task, fail_range_section, get_task, persist_range_section,
        set_task_status,
    };
    use sqlx::{sqlite::SqlitePoolOptions, Row};

    async fn create_test_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory database");
        sqlx::query(include_str!("../schema.sql"))
            .execute(&pool)
            .await
            .expect("initialize schema");
        pool
    }

    #[tokio::test]
    async fn schema_contains_co_reading_tables_and_book_note_author() {
        let pool = create_test_pool().await;

        let settings_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'co_reading_settings'",
        )
        .fetch_one(&pool)
        .await
        .expect("query settings table");
        let blocks_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'co_reading_blocks'",
        )
        .fetch_one(&pool)
        .await
        .expect("query blocks table");
        let author_column: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('book_notes') WHERE name = 'author'",
        )
        .fetch_one(&pool)
        .await
        .expect("query author column");

        assert_eq!(settings_table, 1);
        assert_eq!(blocks_table, 1);
        assert_eq!(author_column, 1);
    }

    #[tokio::test]
    async fn book_note_author_defaults_to_human() {
        let pool = create_test_pool().await;
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO books (id, title, author, format, file_path, file_size, language, created_at, updated_at) VALUES ('book', 'Book', 'Author', 'EPUB', 'book.epub', 1, 'en', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert book");
        sqlx::query(
            "INSERT INTO book_notes (id, book_id, type, cfi, note, created_at, updated_at) VALUES ('note', 'book', 'annotation', 'epubcfi(/6/2)', '', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert note");

        let row = sqlx::query("SELECT author FROM book_notes WHERE id = 'note'")
            .fetch_one(&pool)
            .await
            .expect("read note author");
        let author: String = row.try_get("author").expect("author column");
        assert_eq!(author, "human");
    }

    async fn insert_book(pool: &sqlx::SqlitePool) {
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO books (id, title, author, format, file_path, file_size, language, created_at, updated_at) VALUES ('book', 'Book', 'Author', 'EPUB', 'book.epub', 1, 'en', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert book");
    }

    fn block(block_key: &str, dwell_ms: i64, status: &str) -> CoReadingBlockUpsert {
        CoReadingBlockUpsert {
            id: format!("id-{block_key}"),
            book_id: "book".to_string(),
            block_key: block_key.to_string(),
            focus_key: block_key.to_string(),
            section_index: 1,
            section_label: "Chapter".to_string(),
            cfi: format!("epubcfi(/6/2[{block_key}])"),
            text: format!("Text for {block_key}"),
            text_hash: format!("hash-{block_key}"),
            dwell_ms,
            status: status.to_string(),
            unlocked_at: (status == "queued").then_some(100),
        }
    }

    fn range_data(start_index: i64, end_index: i64) -> CreateCoReadingRangeTaskData {
        CreateCoReadingRangeTaskData {
            book_id: "book".to_string(),
            format: "EPUB".to_string(),
            range_kind: "section".to_string(),
            start_index,
            end_index,
            start_label: "start".to_string(),
            end_label: "end".to_string(),
            start_char_offset: None,
            end_char_offset: None,
            start_percent: None,
            end_percent: None,
        }
    }

    fn status_data(
        task_id: &str,
        status: &str,
        error: Option<&str>,
        expected_updated_at: i64,
    ) -> UpdateCoReadingRangeTaskData {
        UpdateCoReadingRangeTaskData {
            task_id: task_id.to_string(),
            status: status.to_string(),
            error: error.map(str::to_string),
            expected_updated_at,
        }
    }

    async fn ordinary_status(pool: &sqlx::SqlitePool) -> String {
        get_snapshot(pool, "book", 0)
            .await
            .expect("read ordinary follow settings")
            .settings
            .status
    }

    async fn activate_ordinary(pool: &sqlx::SqlitePool) {
        update_settings(
            pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("activate ordinary co-reading");
    }

    #[tokio::test]
    async fn settings_validate_status_and_dwell_range() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;

        let invalid_status = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "running".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await;
        assert!(invalid_status.is_err());

        let invalid_dwell = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 4,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await;
        assert!(invalid_dwell.is_err());

        let settings = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 20,
                rolling_summary: Some("read summary".to_string()),
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("update valid settings");
        assert_eq!(settings.status, "active");
        assert_eq!(settings.dwell_seconds, 20);
    }

    #[tokio::test]
    async fn block_upsert_is_idempotent_and_preserves_terminal_state() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        upsert_blocks(&pool, vec![block("a", 1_000, "tracking")])
            .await
            .expect("insert tracking block");
        upsert_blocks(&pool, vec![block("a", 15_000, "queued")])
            .await
            .expect("queue block");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("claim block");
        complete_batch(
            &pool,
            CompleteCoReadingBatchData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
                status: "silent".to_string(),
                decision: Some("silent".to_string()),
                annotation_id: None,
                annotated_block_key: None,
                annotations: None,
                error: None,
                rolling_summary: Some("summary".to_string()),
            },
        )
        .await
        .expect("complete block");

        upsert_blocks(&pool, vec![block("a", 30_000, "queued")])
            .await
            .expect("repeat upsert");
        let snapshot = get_snapshot(&pool, "book", 0).await.expect("get snapshot");
        assert_eq!(snapshot.blocks.len(), 1);
        assert_eq!(snapshot.blocks[0].status, "silent");
        assert_eq!(snapshot.blocks[0].dwell_ms, 30_000);
        assert_eq!(snapshot.settings.rolling_summary, "summary");
    }

    #[tokio::test]
    async fn current_visible_upsert_rebinds_pending_blocks_but_preserves_owned_or_terminal_focuses()
    {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        for (key, focus) in [("queued-a", "old-a"), ("queued-b", "old-b")] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = focus.to_string();
            upsert_blocks(&pool, vec![item])
                .await
                .expect("insert old queued");
        }
        let mut visible = Vec::new();
        for key in ["queued-a", "queued-b"] {
            let mut item = block(key, 20_000, "tracking");
            item.focus_key = "current-page".to_string();
            visible.push(item);
        }
        let rebound = upsert_blocks(&pool, visible)
            .await
            .expect("rebind current visible queued focus");
        assert!(rebound
            .iter()
            .all(|item| { item.status == "queued" && item.focus_key == "current-page" }));

        let mut processing = block("processing", 20_000, "queued");
        processing.focus_key = "processing-owner".to_string();
        upsert_blocks(&pool, vec![processing])
            .await
            .expect("insert processing");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["processing".to_string()],
            },
        )
        .await
        .expect("claim processing");

        for (key, status, focus) in [
            ("failed", "failed", "failed-owner"),
            ("silent", "silent", "silent-owner"),
            ("annotated", "annotated", "annotated-owner"),
        ] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = focus.to_string();
            upsert_blocks(&pool, vec![item])
                .await
                .expect("insert protected");
            sqlx::query("UPDATE co_reading_blocks SET status=? WHERE block_key=?")
                .bind(status)
                .bind(key)
                .execute(&pool)
                .await
                .expect("set protected status");
        }

        for (key, expected_status, expected_focus) in [
            ("processing", "processing", "processing-owner"),
            ("failed", "failed", "failed-owner"),
            ("silent", "silent", "silent-owner"),
            ("annotated", "annotated", "annotated-owner"),
        ] {
            let mut revisit = block(key, 30_000, "tracking");
            revisit.focus_key = "current-page".to_string();
            let saved = upsert_blocks(&pool, vec![revisit])
                .await
                .expect("revisit protected block");
            assert_eq!(saved[0].status, expected_status);
            assert_eq!(saved[0].focus_key, expected_focus);
        }
    }

    #[tokio::test]
    async fn queued_blocks_return_the_complete_oldest_focus() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        for (key, focus) in [("a", "page-1"), ("b", "page-1"), ("c", "page-2")] {
            let mut block = block(key, 20_000, "queued");
            block.focus_key = focus.to_string();
            upsert_blocks(&pool, vec![block]).await.expect("upsert");
        }
        let queued = queued_blocks(&pool, "book", 1).await.expect("queued");
        assert_eq!(queued.len(), 2);
        assert!(queued.iter().all(|item| item.focus_key == "page-1"));
    }

    #[tokio::test]
    async fn page_claim_is_atomic_when_one_block_is_no_longer_queued() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        for key in ["a", "b"] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = "page-1".to_string();
            upsert_blocks(&pool, vec![item]).await.expect("upsert");
        }
        sqlx::query("UPDATE co_reading_blocks SET status='silent' WHERE block_key='b'")
            .execute(&pool)
            .await
            .expect("change second block");
        let result = claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
            },
        )
        .await;
        assert!(result.is_err());
        let status: String =
            sqlx::query_scalar("SELECT status FROM co_reading_blocks WHERE block_key='a'")
                .fetch_one(&pool)
                .await
                .expect("read first status");
        assert_eq!(status, "queued");
    }

    fn persisted_note(id: &str, block_key: &str) -> CoReadingNoteCreateData {
        CoReadingNoteCreateData {
            id: id.to_string(),
            block_key: block_key.to_string(),
            r#type: "annotation".to_string(),
            cfi: format!("epubcfi(/6/2[{block_key}]/{id})"),
            text: Some(format!("Quote {id}")),
            style: Some("underline".to_string()),
            color: Some("blue".to_string()),
            note: format!("Comment {id}"),
            context: Some(serde_json::json!({"before": "before", "after": "after"})),
        }
    }

    #[tokio::test]
    async fn persist_focus_is_atomic_and_keeps_all_same_block_reviews() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        for key in ["a", "b"] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = "page-1".to_string();
            upsert_blocks(&pool, vec![item]).await.expect("upsert");
        }
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
            },
        )
        .await
        .expect("claim focus");

        let result = persist_focus(
            &pool,
            PersistCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
                notes: vec![persisted_note("note-1", "a"), persisted_note("note-2", "a")],
                rolling_summary: Some("summary".to_string()),
            },
        )
        .await
        .expect("persist focus");
        assert_eq!(result.notes.len(), 2);
        let note_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_notes WHERE book_id='book'")
                .fetch_one(&pool)
                .await
                .expect("count notes");
        assert_eq!(note_count, 2);
        let representative: String =
            sqlx::query_scalar("SELECT annotation_id FROM co_reading_blocks WHERE block_key='a'")
                .fetch_one(&pool)
                .await
                .expect("representative note");
        assert_eq!(representative, "note-1");
        let statuses =
            sqlx::query("SELECT block_key, status FROM co_reading_blocks ORDER BY block_key")
                .fetch_all(&pool)
                .await
                .expect("statuses");
        assert_eq!(
            statuses[0].try_get::<String, _>("status").unwrap(),
            "annotated"
        );
        assert_eq!(
            statuses[1].try_get::<String, _>("status").unwrap(),
            "silent"
        );
        let summary: String = sqlx::query_scalar(
            "SELECT rolling_summary FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .expect("summary");
        assert_eq!(summary, "summary");
    }

    #[tokio::test]
    async fn persist_focus_rolls_back_notes_when_completion_cannot_commit() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        upsert_blocks(&pool, vec![block("a", 20_000, "queued")])
            .await
            .expect("upsert");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("claim");

        let result = persist_focus(
            &pool,
            PersistCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "missing".to_string()],
                notes: vec![persisted_note("note-rollback", "a")],
                rolling_summary: Some("must-not-commit".to_string()),
            },
        )
        .await;
        assert!(result.is_err());
        let note_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_notes WHERE id='note-rollback'")
                .fetch_one(&pool)
                .await
                .expect("count rolled back note");
        assert_eq!(note_count, 0);
        let status: String =
            sqlx::query_scalar("SELECT status FROM co_reading_blocks WHERE block_key='a'")
                .fetch_one(&pool)
                .await
                .expect("status remains processing");
        assert_eq!(status, "processing");
    }

    #[tokio::test]
    async fn persist_focus_replay_is_idempotent_and_rejects_mixed_focus() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        for key in ["a", "b"] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = "page-1".to_string();
            upsert_blocks(&pool, vec![item]).await.expect("upsert");
        }
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
            },
        )
        .await
        .expect("claim focus");

        for _ in 0..2 {
            let result = persist_focus(
                &pool,
                PersistCoReadingFocusData {
                    book_id: "book".to_string(),
                    block_keys: vec!["a".to_string(), "b".to_string()],
                    notes: vec![
                        persisted_note("note-replay-1", "a"),
                        persisted_note("note-replay-2", "a"),
                    ],
                    rolling_summary: Some("replay summary".to_string()),
                },
            )
            .await
            .expect("initial persist and replay must both succeed");
            assert_eq!(result.notes.len(), 2);
        }
        let note_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM book_notes WHERE id IN ('note-replay-1','note-replay-2')",
        )
        .fetch_one(&pool)
        .await
        .expect("count replayed notes");
        assert_eq!(note_count, 2);

        for (key, focus) in [("c", "page-2"), ("d", "page-3")] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = focus.to_string();
            upsert_blocks(&pool, vec![item])
                .await
                .expect("upsert mixed focus");
        }
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["c".to_string(), "d".to_string()],
            },
        )
        .await
        .expect("claim mixed focus fixture");
        let mixed = persist_focus(
            &pool,
            PersistCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["c".to_string(), "d".to_string()],
                notes: Vec::new(),
                rolling_summary: Some("must not persist".to_string()),
            },
        )
        .await
        .expect_err("mixed focuses must be rejected");
        assert!(mixed.contains("同一个非空页面焦点"));

        let duplicate = persist_focus(
            &pool,
            PersistCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["c".to_string(), "c".to_string()],
                notes: Vec::new(),
                rolling_summary: None,
            },
        )
        .await
        .expect_err("duplicate block keys must be rejected");
        assert!(duplicate.contains("非空且唯一"));
    }

    #[tokio::test]
    async fn navigation_release_requeues_the_complete_processing_focus_idempotently() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;
        for key in ["nav-a", "nav-b"] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = "nav-focus".to_string();
            upsert_blocks(&pool, vec![item])
                .await
                .expect("queue navigation focus");
        }
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["nav-a".to_string(), "nav-b".to_string()],
            },
        )
        .await
        .expect("claim navigation focus");

        let released = release_focus(
            &pool,
            ReleaseCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["nav-a".to_string(), "nav-b".to_string()],
            },
        )
        .await
        .expect("release navigation focus");
        assert!(released.released);
        assert!(!released.committed);

        let replay = release_focus(
            &pool,
            ReleaseCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["nav-a".to_string(), "nav-b".to_string()],
            },
        )
        .await
        .expect("replay navigation release");
        assert!(!replay.released);
        assert!(!replay.committed);
        let statuses: Vec<String> = sqlx::query_scalar(
            "SELECT status FROM co_reading_blocks WHERE focus_key='nav-focus' ORDER BY block_key",
        )
        .fetch_all(&pool)
        .await
        .expect("read released focus");
        assert_eq!(statuses, vec!["queued", "queued"]);
    }

    #[tokio::test]
    async fn navigation_release_never_downgrades_an_atomically_committed_focus() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;
        let mut item = block("nav-committed", 20_000, "queued");
        item.focus_key = "nav-committed-focus".to_string();
        upsert_blocks(&pool, vec![item])
            .await
            .expect("queue committed focus");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["nav-committed".to_string()],
            },
        )
        .await
        .expect("claim committed focus");
        persist_focus(
            &pool,
            PersistCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["nav-committed".to_string()],
                notes: Vec::new(),
                rolling_summary: Some("committed summary".to_string()),
            },
        )
        .await
        .expect("commit focus before release race");

        let released = release_focus(
            &pool,
            ReleaseCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["nav-committed".to_string()],
            },
        )
        .await
        .expect("release detects committed focus");
        assert!(!released.released);
        assert!(released.committed);
        let status: String = sqlx::query_scalar(
            "SELECT status FROM co_reading_blocks WHERE block_key='nav-committed'",
        )
        .fetch_one(&pool)
        .await
        .expect("read committed status");
        assert_eq!(status, "silent");
    }

    #[tokio::test]
    async fn navigation_release_rejects_partial_focus_requests() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;
        for key in ["partial-a", "partial-b"] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = "partial-focus".to_string();
            upsert_blocks(&pool, vec![item])
                .await
                .expect("queue partial focus");
        }
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["partial-a".to_string(), "partial-b".to_string()],
            },
        )
        .await
        .expect("claim partial focus");
        let error = release_focus(
            &pool,
            ReleaseCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["partial-a".to_string()],
            },
        )
        .await
        .expect_err("partial release must fail");
        assert!(error.contains("完整页面焦点"));
        let statuses: Vec<String> = sqlx::query_scalar(
            "SELECT status FROM co_reading_blocks WHERE focus_key='partial-focus' ORDER BY block_key",
        )
        .fetch_all(&pool)
        .await
        .expect("read partial focus statuses");
        assert_eq!(statuses, vec!["processing", "processing"]);
    }

    #[tokio::test]
    async fn active_range_blocks_ordinary_claim_and_keeps_blocks_queued() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;
        upsert_blocks(&pool, vec![block("range-claim", 20_000, "queued")])
            .await
            .expect("queue ordinary block");

        let task = create_task(&pool, range_data(1, 2))
            .await
            .expect("create takeover range");
        let claimed = claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["range-claim".to_string()],
            },
        )
        .await
        .expect("blocked ordinary claim returns no blocks");

        assert!(claimed.is_empty());
        let status: String = sqlx::query_scalar(
            "SELECT status FROM co_reading_blocks WHERE book_id='book' AND block_key='range-claim'",
        )
        .fetch_one(&pool)
        .await
        .expect("read blocked block status");
        assert_eq!(status, "queued");
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "running");
        assert_eq!(ordinary_status(&pool).await, "paused");
    }

    #[tokio::test]
    async fn range_takeover_requeues_processing_focus_without_partial_persist() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: Some("summary before takeover".to_string()),
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("seed ordinary summary");
        for key in ["takeover-a", "takeover-b"] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = "takeover-focus".to_string();
            upsert_blocks(&pool, vec![item])
                .await
                .expect("queue takeover focus");
        }
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["takeover-a".to_string(), "takeover-b".to_string()],
            },
        )
        .await
        .expect("claim ordinary focus before takeover");
        let task = create_task(&pool, range_data(2, 3))
            .await
            .expect("create takeover range");

        let error = persist_focus(
            &pool,
            PersistCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["takeover-a".to_string(), "takeover-b".to_string()],
                notes: vec![persisted_note("takeover-note", "takeover-a")],
                rolling_summary: Some("must not replace summary".to_string()),
            },
        )
        .await
        .expect_err("range takeover must cancel ordinary persist");

        assert_eq!(error, "范围阅读已接管，当前普通共读焦点已重新排队");
        let note_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_notes WHERE id='takeover-note'")
                .fetch_one(&pool)
                .await
                .expect("count takeover notes");
        assert_eq!(note_count, 0);
        let statuses: Vec<String> = sqlx::query_scalar(
            "SELECT status FROM co_reading_blocks WHERE block_key IN ('takeover-a','takeover-b') ORDER BY block_key",
        )
        .fetch_all(&pool)
        .await
        .expect("read requeued focus statuses");
        assert_eq!(statuses, vec!["queued", "queued"]);
        let summary: String = sqlx::query_scalar(
            "SELECT rolling_summary FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .expect("read summary after takeover");
        assert_eq!(summary, "summary before takeover");
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "running");
        assert_eq!(ordinary_status(&pool).await, "paused");
    }

    #[tokio::test]
    async fn completed_focus_replay_remains_idempotent_after_range_takeover() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;
        let mut item = block("replay-after-range", 20_000, "queued");
        item.focus_key = "replay-after-range-focus".to_string();
        upsert_blocks(&pool, vec![item])
            .await
            .expect("queue replay focus");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["replay-after-range".to_string()],
            },
        )
        .await
        .expect("claim replay focus");
        let replay_request = || PersistCoReadingFocusData {
            book_id: "book".to_string(),
            block_keys: vec!["replay-after-range".to_string()],
            notes: vec![persisted_note(
                "replay-after-range-note",
                "replay-after-range",
            )],
            rolling_summary: Some("completed replay summary".to_string()),
        };
        persist_focus(&pool, replay_request())
            .await
            .expect("complete ordinary focus");

        let task = create_task(&pool, range_data(3, 4))
            .await
            .expect("create range after ordinary completion");
        let task_before_replay = get_task(&pool, &task.id)
            .await
            .expect("read range before replay");

        let replay = persist_focus(&pool, replay_request())
            .await
            .expect("identical completed replay must survive takeover");

        assert_eq!(replay.notes.len(), 1);
        assert_eq!(replay.notes[0].id, "replay-after-range-note");
        let note_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM book_notes WHERE id='replay-after-range-note'",
        )
        .fetch_one(&pool)
        .await
        .expect("count replay note");
        assert_eq!(note_count, 1);
        let summary: String = sqlx::query_scalar(
            "SELECT rolling_summary FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .expect("read replay summary");
        assert_eq!(summary, "completed replay summary");
        let task_after_replay = get_task(&pool, &task.id)
            .await
            .expect("read range after replay");
        assert_eq!(task_after_replay.status, task_before_replay.status);
        assert_eq!(task_after_replay.updated_at, task_before_replay.updated_at);
        assert_eq!(ordinary_status(&pool).await, "paused");
    }

    #[tokio::test]
    async fn takeover_requeue_failure_rolls_back_the_entire_focus_transaction() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: Some("summary before failed requeue".to_string()),
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("seed failed requeue summary");
        for key in ["requeue-fail-a", "requeue-fail-b"] {
            let mut item = block(key, 20_000, "queued");
            item.focus_key = "requeue-fail-focus".to_string();
            upsert_blocks(&pool, vec![item])
                .await
                .expect("queue failed requeue focus");
        }
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["requeue-fail-a".to_string(), "requeue-fail-b".to_string()],
            },
        )
        .await
        .expect("claim focus before failed requeue");
        let task = create_task(&pool, range_data(4, 5))
            .await
            .expect("create range before failed requeue");
        sqlx::query(
            "CREATE TRIGGER abort_ordinary_requeue BEFORE UPDATE OF status ON co_reading_blocks WHEN OLD.block_key='requeue-fail-b' AND OLD.status='processing' AND NEW.status='queued' BEGIN SELECT RAISE(ABORT, 'forced ordinary requeue failure'); END",
        )
        .execute(&pool)
        .await
        .expect("create requeue failure trigger");

        let error = persist_focus(
            &pool,
            PersistCoReadingFocusData {
                book_id: "book".to_string(),
                block_keys: vec!["requeue-fail-a".to_string(), "requeue-fail-b".to_string()],
                notes: vec![persisted_note("requeue-fail-note", "requeue-fail-a")],
                rolling_summary: Some("must not replace failed requeue summary".to_string()),
            },
        )
        .await
        .expect_err("forced requeue failure must reject persist");

        assert!(error.contains("forced ordinary requeue failure"));
        let note_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_notes WHERE id='requeue-fail-note'")
                .fetch_one(&pool)
                .await
                .expect("count failed requeue note");
        assert_eq!(note_count, 0);
        let statuses: Vec<String> = sqlx::query_scalar(
            "SELECT status FROM co_reading_blocks WHERE block_key IN ('requeue-fail-a','requeue-fail-b') ORDER BY block_key",
        )
        .fetch_all(&pool)
        .await
        .expect("read rolled back processing statuses");
        assert_eq!(statuses, vec!["processing", "processing"]);
        let summary: String = sqlx::query_scalar(
            "SELECT rolling_summary FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .expect("read summary after failed requeue");
        assert_eq!(summary, "summary before failed requeue");
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "running");
        let ordinary: String =
            sqlx::query_scalar("SELECT status FROM co_reading_settings WHERE book_id='book'")
                .fetch_one(&pool)
                .await
                .expect("read ordinary status without stale recovery");
        assert_eq!(ordinary, "paused");
    }

    #[tokio::test]
    async fn failed_blocks_require_retry_before_they_return_to_queue() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        upsert_blocks(&pool, vec![block("a", 15_000, "queued")])
            .await
            .expect("queue block");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("claim block");
        complete_batch(
            &pool,
            CompleteCoReadingBatchData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
                status: "failed".to_string(),
                decision: None,
                annotation_id: None,
                annotated_block_key: None,
                annotations: None,
                error: Some("model failed".to_string()),
                rolling_summary: None,
            },
        )
        .await
        .expect("fail block");

        retry_blocks(
            &pool,
            RetryCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("retry block");
        let snapshot = get_snapshot(&pool, "book", 0).await.expect("get snapshot");
        assert_eq!(snapshot.blocks[0].status, "queued");
        assert!(snapshot.blocks[0].error.is_none());
    }

    #[tokio::test]
    async fn annotated_batch_marks_only_the_selected_block_as_annotated() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        upsert_blocks(
            &pool,
            vec![block("a", 15_000, "queued"), block("b", 15_000, "queued")],
        )
        .await
        .expect("queue blocks");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
            },
        )
        .await
        .expect("claim blocks");
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query("INSERT INTO book_notes (id, book_id, type, cfi, author, note, created_at, updated_at) VALUES ('note', 'book', 'annotation', 'epubcfi(/6/2)', 'ai', '', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .expect("insert annotation");

        complete_batch(
            &pool,
            CompleteCoReadingBatchData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
                status: "annotated".to_string(),
                decision: Some("annotate".to_string()),
                annotation_id: Some("note".to_string()),
                annotated_block_key: Some("b".to_string()),
                annotations: None,
                error: None,
                rolling_summary: None,
            },
        )
        .await
        .expect("complete annotated batch");

        let snapshot = get_snapshot(&pool, "book", 0).await.expect("get snapshot");
        let a = snapshot
            .blocks
            .iter()
            .find(|item| item.block_key == "a")
            .unwrap();
        let b = snapshot
            .blocks
            .iter()
            .find(|item| item.block_key == "b")
            .unwrap();
        assert_eq!(a.status, "silent");
        assert!(a.annotation_id.is_none());
        assert_eq!(b.status, "annotated");
        assert_eq!(b.annotation_id.as_deref(), Some("note"));
    }

    #[tokio::test]
    async fn snapshot_recovers_stale_processing_blocks_to_queue() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        activate_ordinary(&pool).await;

        upsert_blocks(&pool, vec![block("a", 15_000, "queued")])
            .await
            .expect("queue block");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("claim block");
        sqlx::query("UPDATE co_reading_blocks SET updated_at = 1 WHERE block_key = 'a'")
            .execute(&pool)
            .await
            .expect("age processing block");

        let snapshot = get_snapshot(&pool, "book", 1_000)
            .await
            .expect("get snapshot");
        assert_eq!(snapshot.blocks[0].status, "queued");
        assert_eq!(snapshot.stats.queued, 1);
        assert_eq!(snapshot.stats.processing, 0);
    }

    #[tokio::test]
    async fn failed_range_task_resumes_at_same_cursor_and_repauses_follow_mode() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("activate follow mode");
        let task = create_task(
            &pool,
            CreateCoReadingRangeTaskData {
                book_id: "book".to_string(),
                format: "EPUB".to_string(),
                range_kind: "section".to_string(),
                start_index: 2,
                end_index: 5,
                start_label: "start".to_string(),
                end_label: "end".to_string(),
                start_char_offset: None,
                end_char_offset: None,
                start_percent: None,
                end_percent: None,
            },
        )
        .await
        .expect("create range task");
        assert_eq!(task.request_limit, 8);
        assert_eq!(
            get_snapshot(&pool, "book", 0)
                .await
                .expect("read paused follow settings after task creation")
                .settings
                .status,
            "paused"
        );

        sqlx::query(
            "UPDATE co_reading_range_tasks SET cursor_index=4, scanned_count=5, selected_count=3, processed_count=2, request_count=request_limit - 2 WHERE id=?",
        )
        .bind(&task.id)
        .execute(&pool)
        .await
        .expect("set failed progress");
        let failed = set_task_status(
            &pool,
            UpdateCoReadingRangeTaskData {
                task_id: task.id.clone(),
                status: "failed".to_string(),
                error: Some("模型服务额度不足".to_string()),
                expected_updated_at: task.updated_at,
            },
        )
        .await
        .expect("fail range task");
        assert_eq!(failed.id, task.id);
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.cursor_index, 4);
        assert_eq!(failed.scanned_count, 5);
        assert_eq!(failed.selected_count, 3);
        assert_eq!(failed.processed_count, 2);
        assert_eq!(failed.request_count, task.request_limit - 2);
        assert_eq!(failed.request_limit, task.request_limit);
        assert!(failed.request_limit >= failed.request_count + 2);
        assert_eq!(failed.error.as_deref(), Some("模型服务额度不足"));
        assert!(failed.completed_at.is_some());
        assert_eq!(
            get_snapshot(&pool, "book", 0)
                .await
                .expect("read follow settings after task failure")
                .settings
                .status,
            "paused"
        );

        let resumed = set_task_status(
            &pool,
            UpdateCoReadingRangeTaskData {
                task_id: task.id.clone(),
                status: "running".to_string(),
                error: None,
                expected_updated_at: failed.updated_at,
            },
        )
        .await
        .expect("resume failed range task");
        assert_eq!(resumed.id, task.id);
        assert_eq!(resumed.status, "running");
        assert_eq!(resumed.cursor_index, 4);
        assert_eq!(resumed.scanned_count, 5);
        assert_eq!(resumed.selected_count, 3);
        assert_eq!(resumed.processed_count, 2);
        assert_eq!(resumed.request_count, failed.request_count);
        assert_eq!(resumed.request_limit, failed.request_limit);
        assert!(resumed.error.is_none());
        assert!(resumed.completed_at.is_none());
        assert!(resumed.request_limit >= resumed.request_count + 2);
        assert_eq!(
            get_snapshot(&pool, "book", 0)
                .await
                .expect("read follow settings after task resume")
                .settings
                .status,
            "paused"
        );
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "running");
        let resumed = advance_task(
            &pool,
            AdvanceCoReadingRangeTaskData {
                task_id: task.id.clone(),
                expected_updated_at: resumed.updated_at,
                cursor_index: 6,
                scanned_delta: 0,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 0,
            },
        )
        .await
        .expect("advance resumed task to completion cursor");

        let completed = set_task_status(
            &pool,
            UpdateCoReadingRangeTaskData {
                task_id: task.id.clone(),
                status: "completed".to_string(),
                error: None,
                expected_updated_at: resumed.updated_at,
            },
        )
        .await
        .expect("complete resumed range task");
        assert_eq!(completed.id, task.id);
        assert_eq!(completed.status, "completed");
        assert!(completed.completed_at.is_some());
        assert_eq!(
            get_snapshot(&pool, "book", 0)
                .await
                .expect("read restored follow settings after completion")
                .settings
                .status,
            "active"
        );
    }

    #[tokio::test]
    async fn stopped_range_task_restores_previous_active_follow_mode() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("activate follow mode");
        let task = create_task(
            &pool,
            CreateCoReadingRangeTaskData {
                book_id: "book".to_string(),
                format: "EPUB".to_string(),
                range_kind: "section".to_string(),
                start_index: 2,
                end_index: 5,
                start_label: "start".to_string(),
                end_label: "end".to_string(),
                start_char_offset: None,
                end_char_offset: None,
                start_percent: None,
                end_percent: None,
            },
        )
        .await
        .expect("create range task");
        assert_eq!(
            get_snapshot(&pool, "book", 0)
                .await
                .expect("read paused follow settings after task creation")
                .settings
                .status,
            "paused"
        );

        let stopped = set_task_status(
            &pool,
            UpdateCoReadingRangeTaskData {
                task_id: task.id.clone(),
                status: "stopped".to_string(),
                error: None,
                expected_updated_at: task.updated_at,
            },
        )
        .await
        .expect("stop range task");
        assert_eq!(stopped.id, task.id);
        assert_eq!(stopped.status, "stopped");
        assert!(stopped.completed_at.is_some());
        assert_eq!(
            get_snapshot(&pool, "book", 0)
                .await
                .expect("read restored follow settings after stop")
                .settings
                .status,
            "active"
        );
    }

    #[tokio::test]
    async fn long_range_task_budget_covers_every_focus() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(
            &pool,
            CreateCoReadingRangeTaskData {
                book_id: "book".to_string(),
                format: "EPUB".to_string(),
                range_kind: "section".to_string(),
                start_index: 3,
                end_index: 14,
                start_label: "start".to_string(),
                end_label: "end".to_string(),
                start_char_offset: None,
                end_char_offset: None,
                start_percent: None,
                end_percent: None,
            },
        )
        .await
        .expect("create long range task");
        let range_count = task.end_index - task.start_index + 1;
        assert_eq!(task.request_limit, range_count + 2);
        assert_eq!(task.request_limit, 14);
    }

    #[tokio::test]
    async fn range_advance_enforces_budget_nonnegative_deltas_and_cursor_bounds() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(
            &pool,
            CreateCoReadingRangeTaskData {
                book_id: "book".to_string(),
                format: "EPUB".to_string(),
                range_kind: "section".to_string(),
                start_index: 3,
                end_index: 4,
                start_label: "start".to_string(),
                end_label: "end".to_string(),
                start_char_offset: None,
                end_char_offset: None,
                start_percent: None,
                end_percent: None,
            },
        )
        .await
        .expect("create range task");

        let negative = advance_task(
            &pool,
            AdvanceCoReadingRangeTaskData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 3,
                scanned_delta: -1,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 0,
            },
        )
        .await
        .expect_err("negative deltas must fail");
        assert!(negative.contains("不能为负数"));

        let beyond_end = advance_task(
            &pool,
            AdvanceCoReadingRangeTaskData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 6,
                scanned_delta: 0,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 0,
            },
        )
        .await
        .expect_err("cursor beyond inclusive range must fail");
        assert!(beyond_end.contains("游标"));

        sqlx::query("UPDATE co_reading_range_tasks SET request_count=request_limit WHERE id=?")
            .bind(&task.id)
            .execute(&pool)
            .await
            .expect("exhaust request budget");
        let over_budget = advance_task(
            &pool,
            AdvanceCoReadingRangeTaskData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 3,
                scanned_delta: 0,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 1,
            },
        )
        .await
        .expect_err("request budget must be enforced");
        assert!(over_budget.contains("请求预算不足"));
        let unchanged = get_task(&pool, &task.id)
            .await
            .expect("read unchanged task");
        assert_eq!(unchanged.cursor_index, 3);
        assert_eq!(unchanged.request_count, unchanged.request_limit);
    }

    #[tokio::test]
    async fn failed_range_task_cannot_resume_alongside_another_active_task() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let first = create_task(
            &pool,
            CreateCoReadingRangeTaskData {
                book_id: "book".to_string(),
                format: "EPUB".to_string(),
                range_kind: "section".to_string(),
                start_index: 0,
                end_index: 1,
                start_label: "first".to_string(),
                end_label: "first end".to_string(),
                start_char_offset: None,
                end_char_offset: None,
                start_percent: None,
                end_percent: None,
            },
        )
        .await
        .unwrap();
        set_task_status(
            &pool,
            UpdateCoReadingRangeTaskData {
                task_id: first.id.clone(),
                status: "failed".to_string(),
                error: Some("temporary failure".to_string()),
                expected_updated_at: first.updated_at,
            },
        )
        .await
        .unwrap();
        let create_error = create_task(
            &pool,
            CreateCoReadingRangeTaskData {
                book_id: "book".to_string(),
                format: "EPUB".to_string(),
                range_kind: "section".to_string(),
                start_index: 2,
                end_index: 3,
                start_label: "second".to_string(),
                end_label: "second end".to_string(),
                start_char_offset: None,
                end_char_offset: None,
                start_percent: None,
                end_percent: None,
            },
        )
        .await
        .expect_err("failed unresolved task must block normal task creation");
        assert!(create_error.contains("未解决"));
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query("INSERT INTO co_reading_range_tasks (id,book_id,format,range_kind,start_index,end_index,start_label,end_label,status,previous_follow_status,request_limit,cursor_index,created_at,updated_at) VALUES ('other-active','book','EPUB','section',2,3,'second','second end','running','off',8,2,?,?)")
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .expect("insert conflicting active task for resume protection");
        let failed_updated_at = get_task(&pool, &first.id).await.unwrap().updated_at;
        let error = set_task_status(
            &pool,
            UpdateCoReadingRangeTaskData {
                task_id: first.id,
                status: "running".to_string(),
                error: None,
                expected_updated_at: failed_updated_at,
            },
        )
        .await
        .expect_err("another active task must block resume");
        assert!(error.contains("其他未解决"));
        assert_eq!(
            get_task(&pool, "other-active").await.unwrap().status,
            "running"
        );
    }

    #[tokio::test]
    async fn settings_persist_book_model_preference_without_credentials() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;

        let settings = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: Some("kept summary".to_string()),
                model_provider_id: Some("openai".to_string()),
                model_id: Some("gpt-4o-mini".to_string()),
            },
        )
        .await
        .expect("set book model");
        assert_eq!(settings.rolling_summary, "kept summary");
        assert_eq!(settings.model_provider_id, "openai");
        assert_eq!(settings.model_id, "gpt-4o-mini");
        let first_updated_at = settings.updated_at;

        let kept = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "paused".to_string(),
                dwell_seconds: 30,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("update status only");
        assert_eq!(kept.status, "paused");
        assert_eq!(kept.dwell_seconds, 30);
        assert_eq!(kept.rolling_summary, "kept summary");
        assert_eq!(kept.model_provider_id, "openai");
        assert_eq!(kept.model_id, "gpt-4o-mini");
        assert!(kept.updated_at > first_updated_at);

        let cleared = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: Some(String::new()),
                model_id: Some(String::new()),
            },
        )
        .await
        .expect("clear book model");
        assert_eq!(cleared.model_provider_id, "");
        assert_eq!(cleared.model_id, "");
    }

    #[tokio::test]
    async fn completed_requires_end_cursor_and_keeps_follow_mode_paused_on_rejection() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .unwrap();
        let task = create_task(&pool, range_data(0, 1)).await.unwrap();

        let error = set_task_status(
            &pool,
            status_data(&task.id, "completed", None, task.updated_at),
        )
        .await
        .expect_err("completion before end cursor must fail");
        assert!(error.contains("尚未到达结束位置"));
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "running");
        assert_eq!(ordinary_status(&pool).await, "paused");
    }

    #[tokio::test]
    async fn stale_workers_cannot_overwrite_paused_or_stopped_tasks() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .unwrap();
        let task = create_task(&pool, range_data(0, 1)).await.unwrap();
        let paused = set_task_status(
            &pool,
            status_data(&task.id, "paused", None, task.updated_at),
        )
        .await
        .unwrap();
        let stale_failed = set_task_status(
            &pool,
            status_data(&task.id, "failed", Some("late worker"), task.updated_at),
        )
        .await
        .expect_err("old worker must not overwrite pause");
        assert!(stale_failed.contains("其他操作更新"));
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "paused");

        let resumed = set_task_status(
            &pool,
            status_data(&task.id, "running", None, paused.updated_at),
        )
        .await
        .unwrap();
        let stopped = set_task_status(
            &pool,
            status_data(&task.id, "stopped", None, resumed.updated_at),
        )
        .await
        .unwrap();
        let late_failed = set_task_status(
            &pool,
            status_data(
                &task.id,
                "failed",
                Some("late stopped worker"),
                resumed.updated_at,
            ),
        )
        .await
        .expect_err("old worker must not overwrite stop");
        assert!(late_failed.contains("其他操作更新"));
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "stopped");
        assert_eq!(stopped.status, "stopped");
        assert_eq!(ordinary_status(&pool).await, "active");
    }

    #[tokio::test]
    async fn terminal_states_are_immutable_and_same_terminal_replay_has_no_side_effects() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .unwrap();
        let task = create_task(&pool, range_data(0, 0)).await.unwrap();
        let advanced = advance_task(
            &pool,
            AdvanceCoReadingRangeTaskData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 0,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 0,
            },
        )
        .await
        .unwrap();
        let completed = set_task_status(
            &pool,
            status_data(&task.id, "completed", None, advanced.updated_at),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE co_reading_settings SET status='off' WHERE book_id='book'")
            .execute(&pool)
            .await
            .unwrap();
        let replayed = set_task_status(
            &pool,
            status_data(&task.id, "completed", None, advanced.updated_at),
        )
        .await
        .unwrap();
        assert_eq!(replayed.updated_at, completed.updated_at);
        assert_eq!(ordinary_status(&pool).await, "off");
        for (status, error) in [
            ("failed", Some("late")),
            ("paused", None),
            ("running", None),
        ] {
            assert!(set_task_status(
                &pool,
                status_data(&task.id, status, error, completed.updated_at),
            )
            .await
            .is_err());
        }

        let stopped_task = create_task(&pool, range_data(2, 2)).await.unwrap();
        let stopped = set_task_status(
            &pool,
            status_data(&stopped_task.id, "stopped", None, stopped_task.updated_at),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE co_reading_settings SET status='active' WHERE book_id='book'")
            .execute(&pool)
            .await
            .unwrap();
        set_task_status(
            &pool,
            status_data(&stopped_task.id, "stopped", None, stopped.updated_at),
        )
        .await
        .unwrap();
        assert_eq!(ordinary_status(&pool).await, "active");
        for (status, error) in [
            ("failed", Some("late")),
            ("paused", None),
            ("running", None),
        ] {
            assert!(set_task_status(
                &pool,
                status_data(&stopped_task.id, status, error, stopped.updated_at),
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn failed_requires_error_and_unresolved_range_locks_ordinary_follow_status() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .unwrap();
        let task = create_task(&pool, range_data(0, 1)).await.unwrap();
        let empty_error = set_task_status(
            &pool,
            status_data(&task.id, "failed", Some("   "), task.updated_at),
        )
        .await
        .expect_err("failed status must require a non-empty error");
        assert!(empty_error.contains("非空错误信息"));

        for status in ["active", "off"] {
            let error = update_settings(
                &pool,
                UpdateCoReadingSettingsData {
                    book_id: "book".to_string(),
                    status: status.to_string(),
                    dwell_seconds: 20,
                    rolling_summary: None,
                    model_provider_id: None,
                    model_id: None,
                },
            )
            .await
            .expect_err("unresolved range must lock ordinary follow status");
            assert!(error.contains("必须保持暂停"));
        }
        let paused = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "paused".to_string(),
                dwell_seconds: 35,
                rolling_summary: Some("locked summary".to_string()),
                model_provider_id: Some("provider".to_string()),
                model_id: Some("model".to_string()),
            },
        )
        .await
        .expect("paused settings changes must remain allowed");
        assert_eq!(paused.dwell_seconds, 35);
        assert_eq!(paused.model_id, "model");

        let latest = get_task(&pool, &task.id).await.unwrap();
        set_task_status(
            &pool,
            status_data(&task.id, "stopped", None, latest.updated_at),
        )
        .await
        .unwrap();
        let active = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 35,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("terminal range must release ordinary follow lock");
        assert_eq!(active.status, "active");
    }

    #[tokio::test]
    async fn settings_failure_rolls_back_task_status_transaction() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 1)).await.unwrap();
        sqlx::query(
            "CREATE TRIGGER abort_range_settings_update BEFORE UPDATE ON co_reading_settings BEGIN SELECT RAISE(ABORT, 'forced settings failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let error = set_task_status(
            &pool,
            status_data(&task.id, "paused", None, task.updated_at),
        )
        .await
        .expect_err("settings trigger must abort whole range transition");
        assert!(error.contains("forced settings failure"));
        assert_eq!(get_task(&pool, &task.id).await.unwrap().status, "running");
    }

    #[tokio::test]
    async fn create_task_pauses_and_terminal_state_restores_each_previous_follow_status() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        for (index, previous) in ["active", "off", "paused"].into_iter().enumerate() {
            update_settings(
                &pool,
                UpdateCoReadingSettingsData {
                    book_id: "book".to_string(),
                    status: previous.to_string(),
                    dwell_seconds: 15,
                    rolling_summary: None,
                    model_provider_id: None,
                    model_id: None,
                },
            )
            .await
            .unwrap();
            let task = create_task(&pool, range_data(index as i64, index as i64))
                .await
                .unwrap();
            assert_eq!(task.previous_follow_status, previous);
            assert_eq!(ordinary_status(&pool).await, "paused");
            set_task_status(
                &pool,
                status_data(&task.id, "stopped", None, task.updated_at),
            )
            .await
            .unwrap();
            assert_eq!(ordinary_status(&pool).await, previous);
        }
    }

    fn range_footprint(
        task_id: &str,
        block_key: &str,
        status: &str,
        annotation_id: Option<&str>,
    ) -> CoReadingFootprintUpsert {
        CoReadingFootprintUpsert {
            id: format!("foot-{block_key}"),
            task_id: task_id.to_string(),
            book_id: "book".to_string(),
            block_key: block_key.to_string(),
            section_index: 0,
            section_label: "Chapter".to_string(),
            cfi: format!("epubcfi(/6/2[{block_key}])"),
            text: format!(
                "Text for {block_key}. Quote note-1. Quote note-2. Quote note-invalid. Quote note-invalid-cfi. Quote note-rollback-range."
            ),
            text_hash: format!("hash-{block_key}"),
            status: status.to_string(),
            reason: match status {
                "filtered" => Some("navigation".to_string()),
                "failed" => Some("model failed".to_string()),
                _ => None,
            },
            summary: Some("summary".to_string()),
            comment: annotation_id.map(|id| format!("Comment {id}")),
            annotation_id: annotation_id.map(str::to_string),
            processed_at: Some(123),
        }
    }

    #[tokio::test]
    async fn range_section_persists_a_pure_filtered_success_ledger() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 0)).await.unwrap();

        let persisted = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 1,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 0,
                notes: Vec::new(),
                footprints: vec![range_footprint(&task.id, "filtered", "filtered", None)],
                rolling_summary: "unchanged summary".to_string(),
            },
        )
        .await
        .expect("persist pure filtered section");

        assert_eq!(persisted.task.cursor_index, 1);
        assert_eq!(persisted.task.scanned_count, 1);
        assert_eq!(persisted.task.selected_count, 0);
        assert_eq!(persisted.task.processed_count, 0);
        assert_eq!(persisted.task.request_count, 0);
        assert_eq!(persisted.notes.len(), 0);
        assert_eq!(persisted.footprints.len(), 1);
        assert_eq!(persisted.footprints[0].status, "filtered");
        assert_eq!(
            persisted.footprints[0].reason.as_deref(),
            Some("navigation")
        );
        assert!(persisted.footprints[0].processed_at.is_some());
        assert!(persisted.footprints[0].annotation_id.is_none());
        assert!(persisted.footprints[0].comment.is_none());
    }

    #[tokio::test]
    async fn range_section_persists_mixed_filtered_silent_and_annotated_success() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 0)).await.unwrap();

        let persisted = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 3,
                selected_delta: 2,
                processed_delta: 2,
                request_delta: 1,
                notes: vec![persisted_note("note-1", "annotated")],
                footprints: vec![
                    range_footprint(&task.id, "filtered", "filtered", None),
                    range_footprint(&task.id, "silent", "silent", None),
                    range_footprint(&task.id, "annotated", "annotated", Some("note-1")),
                ],
                rolling_summary: "mixed summary".to_string(),
            },
        )
        .await
        .expect("persist mixed final ledger");

        assert_eq!(persisted.task.scanned_count, 3);
        assert_eq!(persisted.task.selected_count, 2);
        assert_eq!(persisted.task.processed_count, 2);
        assert_eq!(persisted.notes.len(), 1);
        assert_eq!(persisted.footprints.len(), 3);
        for status in ["filtered", "silent", "annotated"] {
            assert!(persisted
                .footprints
                .iter()
                .any(|footprint| footprint.status == status));
        }
    }

    #[tokio::test]
    async fn range_section_failure_persists_filtered_and_failed_footprints() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 0)).await.unwrap();

        let failed = fail_range_section(
            &pool,
            FailCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                request_delta: 1,
                error: "model failed".to_string(),
                footprints: vec![
                    range_footprint(&task.id, "filtered", "filtered", None),
                    range_footprint(&task.id, "candidate", "failed", None),
                ],
            },
        )
        .await
        .expect("persist mixed failed section ledger");

        assert_eq!(failed.task.status, "failed");
        assert_eq!(failed.task.cursor_index, 0);
        assert_eq!(failed.task.request_count, 1);
        assert_eq!(failed.footprints.len(), 2);
        assert!(failed
            .footprints
            .iter()
            .any(|footprint| footprint.status == "filtered"));
        assert!(failed
            .footprints
            .iter()
            .any(|footprint| footprint.status == "failed"));
        assert!(failed.footprints.iter().all(|footprint| {
            footprint.processed_at.is_some()
                && footprint
                    .reason
                    .as_deref()
                    .is_some_and(|reason| !reason.trim().is_empty())
                && footprint.annotation_id.is_none()
        }));
    }

    #[tokio::test]
    async fn invalid_range_note_relationship_rolls_back_the_section() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 0)).await.unwrap();
        let mut invalid = range_footprint(&task.id, "a", "annotated", Some("note-1"));
        invalid.comment = Some("does not match representative note".to_string());

        let error = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 1,
                selected_delta: 1,
                processed_delta: 1,
                request_delta: 1,
                notes: vec![persisted_note("note-1", "a")],
                footprints: vec![invalid],
                rolling_summary: "must not persist".to_string(),
            },
        )
        .await
        .expect_err("invalid representative note relation must fail");
        assert!(error.contains("关系不一致"));

        let note_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_notes WHERE id='note-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let footprint_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM co_reading_footprints WHERE task_id=?")
                .bind(&task.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let unchanged = get_task(&pool, &task.id).await.unwrap();
        assert_eq!(note_count, 0);
        assert_eq!(footprint_count, 0);
        assert_eq!(unchanged.cursor_index, 0);
        assert_eq!(unchanged.request_count, 0);
    }

    #[tokio::test]
    async fn range_section_persist_and_fail_are_atomic_and_lease_bound() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 1)).await.unwrap();
        let persisted = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 2,
                selected_delta: 2,
                processed_delta: 2,
                request_delta: 1,
                notes: vec![persisted_note("note-1", "a"), persisted_note("note-2", "a")],
                footprints: vec![
                    range_footprint(&task.id, "a", "annotated", Some("note-1")),
                    range_footprint(&task.id, "b", "silent", None),
                ],
                rolling_summary: "range summary".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(persisted.notes.len(), 2);
        assert_eq!(persisted.footprints.len(), 2);
        assert_eq!(
            persisted
                .footprints
                .iter()
                .find(|footprint| footprint.block_key == "a")
                .and_then(|footprint| footprint.annotation_id.as_deref()),
            Some("note-1")
        );
        assert_eq!(persisted.task.cursor_index, 1);
        assert_eq!(persisted.task.scanned_count, 2);
        assert_eq!(persisted.task.selected_count, 2);
        assert_eq!(persisted.task.processed_count, 2);
        assert_eq!(persisted.task.request_count, 1);
        assert_eq!(ordinary_status(&pool).await, "paused");
        let summary: String = sqlx::query_scalar(
            "SELECT rolling_summary FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(summary, "range summary");

        let stale = advance_task(
            &pool,
            AdvanceCoReadingRangeTaskData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 2,
                scanned_delta: 0,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 0,
            },
        )
        .await
        .expect_err("old revision cannot advance");
        assert!(stale.contains("其他操作更新"));

        let mut failed_footprint = range_footprint(&task.id, "c", "failed", None);
        failed_footprint.section_index = persisted.task.cursor_index;
        let failed = fail_range_section(
            &pool,
            FailCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: persisted.task.updated_at,
                request_delta: 1,
                error: "model failed".to_string(),
                footprints: vec![failed_footprint],
            },
        )
        .await
        .unwrap();
        assert_eq!(failed.task.status, "failed");
        assert_eq!(failed.task.cursor_index, 1);
        assert_eq!(failed.task.request_count, 2);
        assert_eq!(failed.footprints[0].status, "failed");
        assert_eq!(ordinary_status(&pool).await, "paused");

        let resumed = set_task_status(
            &pool,
            status_data(&task.id, "running", None, failed.task.updated_at),
        )
        .await
        .unwrap();
        let old_advance = advance_task(
            &pool,
            AdvanceCoReadingRangeTaskData {
                task_id: task.id.clone(),
                expected_updated_at: failed.task.updated_at,
                cursor_index: 2,
                scanned_delta: 0,
                selected_delta: 0,
                processed_delta: 0,
                request_delta: 0,
            },
        )
        .await
        .expect_err("worker from before failed-task resume cannot advance the new attempt");
        assert!(old_advance.contains("其他操作更新"));
        let old_lease = fail_range_section(
            &pool,
            FailCoReadingRangeSectionData {
                task_id: task.id,
                expected_updated_at: persisted.task.updated_at,
                request_delta: 0,
                error: "late failure".to_string(),
                footprints: Vec::new(),
            },
        )
        .await
        .expect_err("old worker cannot fail resumed attempt");
        assert!(old_lease.contains("其他操作更新"));
        assert_eq!(resumed.status, "running");
    }

    #[tokio::test]
    async fn range_section_validation_and_transaction_failures_roll_back() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 0)).await.unwrap();
        let duplicate = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 2,
                selected_delta: 2,
                processed_delta: 2,
                request_delta: 1,
                notes: vec![persisted_note("note-invalid", "a")],
                footprints: vec![
                    range_footprint(&task.id, "a", "annotated", Some("note-invalid")),
                    range_footprint(&task.id, "a", "annotated", Some("note-invalid")),
                ],
                rolling_summary: "must roll back".to_string(),
            },
        )
        .await
        .expect_err("duplicate blocks must be rejected");
        assert!(duplicate.contains("不能重复"));

        let mut wrong_book_footprint = range_footprint(&task.id, "a", "silent", None);
        wrong_book_footprint.book_id = "other-book".to_string();
        let wrong_book = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 1,
                selected_delta: 1,
                processed_delta: 1,
                request_delta: 1,
                notes: Vec::new(),
                footprints: vec![wrong_book_footprint],
                rolling_summary: "must not persist".to_string(),
            },
        )
        .await
        .expect_err("footprints from another book must be rejected");
        assert!(wrong_book.contains("不匹配"));

        let mut invalid_note = persisted_note("note-invalid-cfi", "a");
        invalid_note.cfi = "  ".to_string();
        invalid_note.text = Some("Quote outside the footprint".to_string());
        let invalid_note_error = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 1,
                selected_delta: 1,
                processed_delta: 1,
                request_delta: 1,
                notes: vec![invalid_note],
                footprints: vec![range_footprint(
                    &task.id,
                    "a",
                    "annotated",
                    Some("note-invalid-cfi"),
                )],
                rolling_summary: "must not persist".to_string(),
            },
        )
        .await
        .expect_err("notes without a valid CFI must be rejected");
        assert!(invalid_note_error.contains("有效 CFI"));

        sqlx::query("CREATE TRIGGER abort_range_task_progress BEFORE UPDATE OF cursor_index ON co_reading_range_tasks BEGIN SELECT RAISE(ABORT, 'forced task failure'); END")
            .execute(&pool)
            .await
            .unwrap();
        let error = persist_range_section(
            &pool,
            PersistCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                cursor_index: 1,
                scanned_delta: 1,
                selected_delta: 1,
                processed_delta: 1,
                request_delta: 1,
                notes: vec![persisted_note("note-rollback-range", "a")],
                footprints: vec![range_footprint(
                    &task.id,
                    "a",
                    "annotated",
                    Some("note-rollback-range"),
                )],
                rolling_summary: "must roll back".to_string(),
            },
        )
        .await
        .expect_err("task trigger aborts full section transaction");
        assert!(error.contains("forced task failure"));
        let note_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM book_notes WHERE id='note-rollback-range'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let footprint_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM co_reading_footprints WHERE task_id=?")
                .bind(&task.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let summary: String = sqlx::query_scalar(
            "SELECT rolling_summary FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(note_count, 0);
        assert_eq!(footprint_count, 0);
        assert_eq!(summary, "");
        assert_eq!(get_task(&pool, &task.id).await.unwrap().cursor_index, 0);
    }

    #[tokio::test]
    async fn range_section_failure_rolls_back_when_settings_pause_fails() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        let task = create_task(&pool, range_data(0, 0)).await.unwrap();
        sqlx::query("CREATE TRIGGER abort_range_failure_pause BEFORE UPDATE ON co_reading_settings BEGIN SELECT RAISE(ABORT, 'forced failure pause error'); END")
            .execute(&pool)
            .await
            .unwrap();

        let error = fail_range_section(
            &pool,
            FailCoReadingRangeSectionData {
                task_id: task.id.clone(),
                expected_updated_at: task.updated_at,
                request_delta: 1,
                error: "model failed".to_string(),
                footprints: vec![range_footprint(&task.id, "a", "failed", None)],
            },
        )
        .await
        .expect_err("settings failure must roll back the failed section transaction");
        assert!(error.contains("forced failure pause error"));
        let unchanged = get_task(&pool, &task.id).await.unwrap();
        assert_eq!(unchanged.status, "running");
        assert_eq!(unchanged.request_count, 0);
        let footprint_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM co_reading_footprints WHERE task_id=?")
                .bind(&task.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(footprint_count, 0);
    }

    #[tokio::test]
    async fn create_task_rolls_back_when_settings_pause_fails() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        get_snapshot(&pool, "book", 0).await.unwrap();
        sqlx::query("CREATE TRIGGER abort_create_task_pause BEFORE UPDATE ON co_reading_settings BEGIN SELECT RAISE(ABORT, 'forced pause failure'); END")
            .execute(&pool)
            .await
            .unwrap();
        let error = create_task(&pool, range_data(0, 0))
            .await
            .expect_err("settings pause failure must roll task insert back");
        assert!(error.contains("forced pause failure"));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM co_reading_range_tasks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
