use jt_tenancy::Permission;
#[test]
fn social_tools_are_exact_strict_and_agent_work_scoped() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.social."))
        .collect();
    let mut names: Vec<_> = tools.iter().map(|t| t.name).collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "jeeta.social.account_get",
            "jeeta.social.accounts_list",
            "jeeta.social.version_schedule",
            "jeeta.social.versions_waiting",
        ]
    );
    for t in &tools {
        assert_eq!(t.permissions, &[Permission::SocialWork], "{}", t.name);
        assert_eq!(
            t.input_schema.as_value()["additionalProperties"],
            false,
            "{}",
            t.name
        );
    }
    // Giving a version a time names all it needs, and nothing is optional about it.
    let schedule = tools
        .iter()
        .find(|t| t.name == "jeeta.social.version_schedule")
        .unwrap();
    let mut required: Vec<_> = schedule.input_schema.as_value()["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    required.sort();
    assert_eq!(
        required,
        [
            "capability_id",
            "project_id",
            "publish_at",
            "request_key",
            "version_id"
        ]
    );
    // A person's decision has no tool: pausing an account.
    assert!(
        jt_app::catalog::find("social.account_pause")
            .unwrap()
            .panel_only
    );
}
