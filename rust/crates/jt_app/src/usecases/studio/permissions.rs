//! Module permissions shared by application entry points and MCP discovery.
use crate::gate::studio_module;
use crate::usecases::modules::{ADS, CONTENT, MATERIALS, SOCIAL};
use Permission::*;
use jt_tenancy::Permission;

/// At least one grant is required. Lane/target controls additionally check their input.
/// Unknown ids fail closed. Module ownership comes from the gate's single mapping.
pub fn for_use_case(id: &str) -> &'static [Permission] {
    match id {
        "studio.overview" | "studio.pending" => &[
            ContentWork,
            SocialWork,
            AdsWork,
            MaterialsWork,
            SocialManage,
            AdsManage,
            BudgetManage,
        ],
        "studio.learned" | "studio.ledger" | "studio.ledger_export" => {
            &[ContentWork, SocialWork, AdsWork, MaterialsWork]
        }
        "studio.judgment_record" | "studio.trend_record" | "studio.hypothesis_propose" => {
            &[ContentWork, SocialWork, AdsWork]
        }
        "studio.brake" => &[SocialManage, AdsManage, BudgetManage],
        "studio.approve" => &[SocialManage, AdsManage],
        "studio.project_create" | "studio.project_update" | "studio.project_production" => {
            &[ContentManage]
        }
        // An area's working operations: the agent working it attaches what it produced and asks
        // for a real capture, and whoever supplies the capture answers the request.
        "studio.project_materials" | "studio.project_request" | "studio.project_request_update" => {
            &[ContentWork, ContentManage]
        }
        "studio.project_schedule" | "studio.tiktok_posting" | "studio.tiktok_post" => {
            &[SocialManage]
        }
        "studio.budget_move" => &[AdsManage],
        _ => match studio_module(id) {
            Some(CONTENT) => &[ContentWork],
            Some(SOCIAL) => &[SocialWork],
            Some(ADS) => &[AdsWork],
            Some(MATERIALS) => &[MaterialsWork],
            _ => &[],
        },
    }
}
