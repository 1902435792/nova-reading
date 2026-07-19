use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingSettings {
    pub book_id: String,
    pub status: String,
    pub dwell_seconds: i64,
    pub rolling_summary: String,
    /// Provider id only (no credentials). Empty means follow global selected model.
    pub model_provider_id: String,
    /// Model id within provider. Empty means follow global selected model.
    pub model_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingBlock {
    pub id: String,
    pub book_id: String,
    pub block_key: String,
    pub focus_key: String,
    pub section_index: i64,
    pub section_label: String,
    pub cfi: String,
    pub text: String,
    pub text_hash: String,
    pub dwell_ms: i64,
    pub status: String,
    pub decision: Option<String>,
    pub annotation_id: Option<String>,
    pub error: Option<String>,
    pub unlocked_at: Option<i64>,
    pub processed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingStats {
    pub tracking: i64,
    pub queued: i64,
    pub processing: i64,
    pub silent: i64,
    pub annotated: i64,
    pub failed: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingSnapshot {
    pub settings: CoReadingSettings,
    pub stats: CoReadingStats,
    pub blocks: Vec<CoReadingBlock>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCoReadingSettingsData {
    pub book_id: String,
    pub status: String,
    pub dwell_seconds: i64,
    pub rolling_summary: Option<String>,
    /// When omitted, keep existing book preference.
    pub model_provider_id: Option<String>,
    /// When omitted, keep existing book preference.
    pub model_id: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingBlockUpsert {
    pub id: String,
    pub book_id: String,
    pub block_key: String,
    pub focus_key: String,
    pub section_index: i64,
    pub section_label: String,
    pub cfi: String,
    pub text: String,
    pub text_hash: String,
    pub dwell_ms: i64,
    pub status: String,
    pub unlocked_at: Option<i64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCoReadingBlocksData {
    pub book_id: String,
    pub block_keys: Vec<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompleteCoReadingBatchData {
    pub book_id: String,
    pub block_keys: Vec<String>,
    pub status: String,
    pub decision: Option<String>,
    pub annotation_id: Option<String>,
    pub annotated_block_key: Option<String>,
    /// Optional per-block annotation mapping for a page/spread with multiple reviews.
    pub annotations: Option<std::collections::HashMap<String, String>>,
    pub error: Option<String>,
    pub rolling_summary: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingNoteCreateData {
    pub id: String,
    pub block_key: String,
    pub r#type: String,
    pub cfi: String,
    pub text: Option<String>,
    pub style: Option<String>,
    pub color: Option<String>,
    pub note: String,
    pub context: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistCoReadingFocusData {
    pub book_id: String,
    pub block_keys: Vec<String>,
    pub notes: Vec<CoReadingNoteCreateData>,
    pub rolling_summary: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistCoReadingFocusResult {
    pub notes: Vec<crate::core::books::models::BookNote>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCoReadingFocusData {
    pub book_id: String,
    pub block_keys: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCoReadingFocusResult {
    pub released: bool,
    pub committed: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RetryCoReadingBlocksData {
    pub book_id: String,
    pub block_keys: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingRangeTask {
    pub id: String,
    pub book_id: String,
    pub format: String,
    pub range_kind: String,
    pub start_index: i64,
    pub end_index: i64,
    pub start_label: String,
    pub end_label: String,
    pub start_char_offset: Option<i64>,
    pub end_char_offset: Option<i64>,
    pub start_percent: Option<f64>,
    pub end_percent: Option<f64>,
    pub status: String,
    pub previous_follow_status: String,
    pub candidate_limit: i64,
    pub per_section_limit: i64,
    pub request_limit: i64,
    pub scanned_count: i64,
    pub selected_count: i64,
    pub processed_count: i64,
    pub request_count: i64,
    pub cursor_index: i64,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingFootprint {
    pub id: String,
    pub task_id: String,
    pub book_id: String,
    pub block_key: String,
    pub section_index: i64,
    pub section_label: String,
    pub cfi: String,
    pub text: String,
    pub text_hash: String,
    pub status: String,
    pub reason: Option<String>,
    pub summary: Option<String>,
    pub comment: Option<String>,
    pub annotation_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub processed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingRangeSnapshot {
    pub tasks: Vec<CoReadingRangeTask>,
    pub footprints: Vec<CoReadingFootprint>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateCoReadingRangeTaskData {
    pub book_id: String,
    pub format: String,
    pub range_kind: String,
    pub start_index: i64,
    pub end_index: i64,
    pub start_label: String,
    pub end_label: String,
    pub start_char_offset: Option<i64>,
    pub end_char_offset: Option<i64>,
    pub start_percent: Option<f64>,
    pub end_percent: Option<f64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCoReadingRangeTaskData {
    pub task_id: String,
    pub status: String,
    pub error: Option<String>,
    pub expected_updated_at: i64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingFootprintUpsert {
    pub id: String,
    pub task_id: String,
    pub book_id: String,
    pub block_key: String,
    pub section_index: i64,
    pub section_label: String,
    pub cfi: String,
    pub text: String,
    pub text_hash: String,
    pub status: String,
    pub reason: Option<String>,
    pub summary: Option<String>,
    pub comment: Option<String>,
    pub annotation_id: Option<String>,
    pub processed_at: Option<i64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceCoReadingRangeTaskData {
    pub task_id: String,
    pub expected_updated_at: i64,
    pub cursor_index: i64,
    pub scanned_delta: i64,
    pub selected_delta: i64,
    pub processed_delta: i64,
    pub request_delta: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistCoReadingRangeSectionData {
    pub task_id: String,
    pub expected_updated_at: i64,
    pub cursor_index: i64,
    pub scanned_delta: i64,
    pub selected_delta: i64,
    pub processed_delta: i64,
    pub request_delta: i64,
    pub notes: Vec<CoReadingNoteCreateData>,
    pub footprints: Vec<CoReadingFootprintUpsert>,
    pub rolling_summary: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistCoReadingRangeSectionResult {
    pub task: CoReadingRangeTask,
    pub notes: Vec<crate::core::books::models::BookNote>,
    pub footprints: Vec<CoReadingFootprint>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailCoReadingRangeSectionData {
    pub task_id: String,
    pub expected_updated_at: i64,
    pub request_delta: i64,
    pub error: String,
    pub footprints: Vec<CoReadingFootprintUpsert>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailCoReadingRangeSectionResult {
    pub task: CoReadingRangeTask,
    pub footprints: Vec<CoReadingFootprint>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoReadingDiarySourceRecord {
    pub source_key: String,
    pub source_kind: String,
    pub source_annotation_id: Option<String>,
    pub task_id: Option<String>,
    pub block_key: Option<String>,
    pub book_id: String,
    pub section_index: i64,
    pub section_label: String,
    pub cfi: String,
    pub text: String,
    pub comment: Option<String>,
    pub summary: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub annotation_id: Option<String>,
    pub written_at: Option<i64>,
    pub diary_id: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarkCoReadingDiaryWrittenData {
    pub book_id: String,
    pub diary_id: String,
    pub source_keys: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarkCoReadingDiaryWrittenResult {
    pub diary_id: String,
    pub written_count: usize,
}
