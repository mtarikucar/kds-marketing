//! The agents' prospecting playbook (spec Appendix A), served by `jeeta.prospects.playbook` and
//! shown on the panel's pool page. `jt_archtest` compares [`TEXT`] with the spec's appendix, so
//! the two never drift: change both together, and bump [`PLAYBOOK_VERSION`].

/// The playbook's version; agents see it with the text.
pub const PLAYBOOK_VERSION: u32 = 1;

/// The playbook, in English, for agents.
pub const TEXT: &str = r#"JEETA PROSPECTING PLAYBOOK v1

Purpose. You find businesses that fit this workspace's approved ideal customer profile (ICP), record them in
Jeeta's prospect pool with evidence, score them against the workspace's rubric, and promote the ones worth
contacting. Jeeta never browses or calls any data service: you research with your own tools (web search, a
browser, and, if this workspace has one, the phone through jeeta.devices.*). Jeeta stores, checks, dedupes,
assigns and fences what you record.

Before you start.
1. Call jeeta.work.checkin. Research when it lists research_due; score when it lists prospects_to_score;
   promote when it lists prospects_to_promote.
2. Read this playbook's workspace section: the ICP entries, the rubric and its digest, today's remaining caps.
3. Call jeeta.research.tasks_get for the task, and jeeta.research.tasks_claim before working on it.

Finding businesses.
- Work one ICP entry at a time: its sectors, areas, signals and exclusions.
- Discover candidates on public pages: search results, business directories, map listings viewed in a browser,
  the business's own website and its official social profiles.
- Before researching a business in depth, call jeeta.prospects.check with what you know (name and city, phone,
  website, handles). Skip it if the answer is duplicate, possible_duplicate, in_inbox, previously_rejected or
  do_not_contact.
- Pace yourself like a person: open pages one at a time; never run bulk or automated extraction against a site;
  respect robots.txt and each site's terms; never log in to see data that is not public.

What to record (jeeta.prospects.create).
- business_name, entity_kind (legal_entity for a company such as A.Ş. or Ltd. Şti., sole_trader for a
  sole proprietorship or esnaf, unknown_business if you cannot tell), sector, city, district, language,
  segment_key (from the ICP entry), size (branches, employee band), signals (why it fits, each with its source).
- Contact fields: phone, email, website, instagram, tiktok, address, contact_person. Each field needs at least
  one source URL of a public page where the business itself publishes that value (its website's contact page,
  its official profile, its listing). Give captured_at: when you saw it.
- Never record: a private individual who is not acting as a business; personal social accounts of employees or
  owners; home addresses; personal phone numbers or emails that the business does not publish as its contact;
  data from leaked databases, people-search or data-broker sites; emails you guessed from a pattern (such as
  name@domain) — only addresses you saw published; anything about health, religion, politics, ethnicity or
  other special categories.
- contact_person only when the business publishes the name and role itself (for example an "About" page);
  name and role only.
- Notes describe the business, never a person.

Scoring (jeeta.prospects.score).
- Score 0-100 with the workspace's rubric: one reason per criterion, the points you give it (up to its weight),
  and the evidence in one sentence with its source. The points must add up to the score. Send the rubric_digest
  from this playbook; if Jeeta answers rubric_mismatch, read the playbook again.
- A score at or above qualify_at qualifies the prospect automatically. Reject what does not fit with
  jeeta.prospects.decide and a reason (not_icp, closed_business, no_contact_data, competitor, already_customer,
  duplicate, other with a note).

Promoting (jeeta.prospects.promote).
- Promote qualified prospects you intend to contact soon. Promotion creates the person and the sales journey in
  the inbox; Jeeta assigns an owner by the workspace's rules. Do not promote more than you can contact this week.
- Never contact a prospect that is not promoted. Contact happens through Jeeta (campaigns or the inbox), never
  from your own accounts.

Objections and corrections.
- If a business asks not to be contacted, call jeeta.prospects.do_not_contact (reason objected) at once.
- If you find a recorded value is wrong or no longer published, update or clear it with jeeta.prospects.update.

Limits.
- Respect today's remaining count per task; Jeeta refuses beyond it (daily_cap).
- Rejected and unpromoted prospects are deleted after the workspace's retention period; do not keep copies of
  pool data in your own notes or memory beyond the current task.

Learning.
- Once a week read jeeta.prospects.report (by score bucket, sector and source) and jeeta.outreach.report. Adjust
  which businesses you look for within the approved ICP. To change the ICP or the rubric, propose it to the owner
  through the strategy consultation (jeeta.strategy.start_consultation); it applies once approved."#;
