use jt_tenancy::Permission;
#[test]
fn ads_tools_are_exact_strict_and_agent_work_scoped() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.ads."))
        .collect();
    let mut names: Vec<_> = tools.iter().map(|t| t.name).collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "jeeta.ads.ad_preview",
            "jeeta.ads.campaign_claim",
            "jeeta.ads.campaign_get",
            "jeeta.ads.campaign_move",
            "jeeta.ads.campaign_pause",
            "jeeta.ads.campaign_propose",
            "jeeta.ads.campaign_release",
            "jeeta.ads.campaigns_list",
            "jeeta.ads.plan_submit",
        ]
    );
    for t in &tools {
        assert_eq!(t.permissions, &[Permission::AdsWork], "{}", t.name);
        assert_eq!(
            t.input_schema.as_value()["additionalProperties"],
            false,
            "{}",
            t.name
        );
    }
    // The plan is a closed schema: an unknown field is refused at every level an agent fills.
    let plan = tools
        .iter()
        .find(|t| t.name == "jeeta.ads.plan_submit")
        .unwrap()
        .input_schema
        .as_value()["properties"]["plan"]
        .clone();
    assert_eq!(plan["additionalProperties"], false);
    assert_eq!(
        plan["properties"]["audience"]["additionalProperties"],
        false
    );
    assert_eq!(
        plan["properties"]["ads"]["items"]["additionalProperties"],
        false
    );
    assert_eq!(plan["properties"]["ads"]["maxItems"], 6);
    assert_eq!(plan["properties"]["special_ad_categories"]["maxItems"], 0);
    // A person's decisions have no tool: opening, approving, declining, letting go on, ending,
    // changing the budget.
    for id in [
        "ads.campaign_open",
        "ads.campaign_approve",
        "ads.campaign_decline",
        "ads.campaign_resume",
        "ads.campaign_end",
        "ads.campaign_update",
    ] {
        let row = jt_app::catalog::find(id).unwrap();
        assert!(row.panel_only && row.mcp_tool.is_none(), "{id}");
    }
    // An agent proposes through its tool alone.
    let propose = jt_app::catalog::find("ads.campaign_propose").unwrap();
    assert!(propose.mcp_only && propose.panel_route.is_none());
}
