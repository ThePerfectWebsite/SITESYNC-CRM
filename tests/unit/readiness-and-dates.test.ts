import { describe, expect, it } from "vitest";
import { keyForLabel } from "@/server/records/checklist";
import { addDays, isOverdue, isValidTimeZone, todayIn } from "@/server/records/dates";
import { evaluateReadiness, waiverApplies, type Blocker, type WaiverView } from "@/server/records/readiness";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const blocker = (key: string, waivable = true): Blocker => ({
  key,
  type: key.startsWith("task:") ? "critical_task" : "checklist_item",
  label: key,
  waivable,
  snapshot: {},
});

const waiver = (blockerKey: string, commitSha: string | null = null, id = blockerKey): WaiverView => ({
  id,
  blockerKey,
  blockerType: "checklist_item",
  blockerSnapshot: {},
  reason: "Accepted",
  commitSha,
  createdAt: new Date(),
  waivedByName: "Op",
});

describe("waiver matching", () => {
  it("an unscoped waiver applies to any target", () => {
    expect(waiverApplies({ commitSha: null })).toBe(true);
    expect(waiverApplies({ commitSha: null }, { commitSha: SHA_A })).toBe(true);
  });

  it("a commit-scoped waiver applies only while the proposed commit equals its SHA", () => {
    expect(waiverApplies({ commitSha: SHA_A }, { commitSha: SHA_A })).toBe(true);
    expect(waiverApplies({ commitSha: SHA_A }, { commitSha: SHA_B })).toBe(false);
    // No proposed commit: a scoped waiver can't be shown to match, so it doesn't.
    expect(waiverApplies({ commitSha: SHA_A })).toBe(false);
    expect(waiverApplies({ commitSha: SHA_A }, { commitSha: null })).toBe(false);
  });
});

describe("evaluateReadiness", () => {
  it("is ready with no blockers", () => {
    expect(evaluateReadiness([], [])).toEqual({ ready: true, blockers: [], waived: [], inactiveWaivers: [] });
  });

  it("blocks on any unwaived blocker and moves waived ones aside", () => {
    const result = evaluateReadiness([blocker("task:1"), blocker("checklist:dns")], [waiver("checklist:dns")]);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.key)).toEqual(["task:1"]);
    expect(result.waived.map((w) => w.blocker.key)).toEqual(["checklist:dns"]);
  });

  it("is ready when every blocker is waived", () => {
    const result = evaluateReadiness([blocker("task:1")], [waiver("task:1")]);
    expect(result.ready).toBe(true);
  });

  it("matches waivers by exact key only", () => {
    const result = evaluateReadiness([blocker("checklist:dns")], [waiver("checklist:dns_ssl")]);
    expect(result.ready).toBe(false);
    expect(result.inactiveWaivers.map((w) => w.blockerKey)).toEqual(["checklist:dns_ssl"]);
  });

  it("commit-scoped waivers count only for their commit", () => {
    const blockers = [blocker("checklist:dns")];
    const scoped = [waiver("checklist:dns", SHA_A)];
    expect(evaluateReadiness(blockers, scoped, { commitSha: SHA_A }).ready).toBe(true);
    const other = evaluateReadiness(blockers, scoped, { commitSha: SHA_B });
    expect(other.ready).toBe(false);
    expect(other.inactiveWaivers).toHaveLength(1);
    expect(evaluateReadiness(blockers, scoped).ready).toBe(false);
  });

  it("never waives an unwaivable blocker", () => {
    const result = evaluateReadiness([blocker("hosting:missing", false)], [waiver("hosting:missing")]);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.key)).toEqual(["hosting:missing"]);
  });

  it("reports waivers whose blocker was resolved as inactive", () => {
    const result = evaluateReadiness([], [waiver("task:gone")]);
    expect(result.ready).toBe(true);
    expect(result.inactiveWaivers.map((w) => w.blockerKey)).toEqual(["task:gone"]);
  });
});

describe("calendar dates and time zones", () => {
  // 23:30 UTC on 3 Nov 2026 is still the 3rd in London (GMT) and Los Angeles,
  // but already the 4th in Auckland (NZDT, UTC+13).
  const lateUtc = new Date("2026-11-03T23:30:00Z");

  it("today depends on the app's time zone, not UTC", () => {
    expect(todayIn("Europe/London", lateUtc)).toBe("2026-11-03");
    expect(todayIn("America/Los_Angeles", lateUtc)).toBe("2026-11-03");
    expect(todayIn("Pacific/Auckland", lateUtc)).toBe("2026-11-04");
    expect(todayIn("UTC", lateUtc)).toBe("2026-11-03");
  });

  it("handles DST transitions (London clocks went back on 25 Oct 2026)", () => {
    expect(todayIn("Europe/London", new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25"); // BST, UTC+1
    expect(todayIn("Europe/London", new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-25"); // GMT
  });

  it("a task due today is not overdue; due yesterday is", () => {
    expect(isOverdue("2026-11-03", "2026-11-03")).toBe(false);
    expect(isOverdue("2026-11-02", "2026-11-03")).toBe(true);
    expect(isOverdue("2026-11-04", "2026-11-03")).toBe(false);
    expect(isOverdue(null, "2026-11-03")).toBe(false);
  });

  it("the same due date flips to overdue at local midnight, wherever that is", () => {
    const due = "2026-11-03";
    expect(isOverdue(due, todayIn("Pacific/Auckland", lateUtc))).toBe(true);
    expect(isOverdue(due, todayIn("Europe/London", lateUtc))).toBe(false);
  });

  it("adds calendar days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-11-03", 14)).toBe("2026-11-17");
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29"); // UK DST start, no effect on dates
  });

  it("validates time zone names", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe("checklist template keys", () => {
  it("derives a unique key from the label", () => {
    expect(keyForLabel("DNS & SSL verified", new Set())).toBe("dns_ssl_verified");
    expect(keyForLabel("DNS & SSL verified", new Set(["dns_ssl_verified"]))).toBe("dns_ssl_verified_2");
    expect(keyForLabel("404 page", new Set())).toBe("item_404_page");
    expect(keyForLabel("!!!", new Set())).toBe("item");
  });
});
