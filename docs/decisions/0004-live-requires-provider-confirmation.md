# 0004 — Live requires provider confirmation; no operator-attested path

**Context.** The prompt requires that a project becomes Live only after a provider-confirmed deploy, and also that manual workflows work with zero credentials. A website with no hosting integration can never get provider confirmation (spec OQ-1).

**Decision (operator, 2026-11-03).** Strict. `go_live` accepts only a production deployment with `state='published'` and `confirmation_source='provider'` on a hosting link backed by an integration. `confirmation_source` allows only `'provider'`; `manual_record` deployments are history only and can never trigger Live.

Projects without a connected hosting provider stop at Ready to Deploy, with an explanation on the overview. To keep manual work unblocked, the operator may `skip_forward` past Live (e.g. to Maintenance) with a reason. This is allowed only when the website has no integration-backed production link. Live is then recorded as `skipped`, never `completed`.

**Alternatives.** Operator-attested manual deploy record (reason + password, labelled "not provider-confirmed") that could trigger Live — rejected by the operator because it weakens what "Live" means.
