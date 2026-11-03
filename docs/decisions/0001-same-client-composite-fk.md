# 0001 — Enforce "project website belongs to project client" with a composite FK

**Context.** A project belongs to one client and must target a website of that same client. Enforcing this only in the service layer leaves the DB able to hold inconsistent rows (scripts, future bugs, restores).

**Decision.** `websites` gets `UNIQUE (id, client_id)`. `projects` holds both `client_id` and `website_id` with `FOREIGN KEY (website_id, client_id) REFERENCES websites (id, client_id)`. The service layer also validates, to return a friendly error.

**Alternatives.** (a) Trigger that looks up the website's client — works but is less transparent and slower. (b) Drop `projects.client_id` and derive it from the website — simpler, but makes client-level queries join through websites and loses the explicit relationship the prompt asks for.
