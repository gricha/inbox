import XCTest

@testable import Inbox

// The window's own words, against the cases web/test/view.test.ts and notices.test.ts hold web/src/format.ts to.
final class FormatTests: XCTestCase {
  private let now = Words.date("2026-10-27T12:00:00Z")!
  private func back(_ hours: Double) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(-hours * 3600)) }

  private func card(_ json: String = "") throws -> Card {
    let base = #"{"id":"a/b#1","kind":"pr","repo":"getsentry/seer","number":9085,"title":"t""#
    return try DeskJSON.decoder().decode(Card.self, from: Data("\(base)\(json.isEmpty ? "" : ",")\(json)}".utf8))
  }

  func testAge() {
    XCTAssertEqual(Words.age("2026-10-27T11:20:00Z", now: now), "40m")
    XCTAssertEqual(Words.age("2026-10-27T07:00:00Z", now: now), "5h")
    XCTAssertEqual(Words.age("2026-10-24T12:00:00Z", now: now), "3d")
    // Rounded before the switch to days: 47.6h and 48.3h both read "2d".
    XCTAssertEqual(Words.age(back(47.6), now: now), "2d")
    XCTAssertEqual(Words.age(back(48.3), now: now), "2d")
    XCTAssertEqual(Words.age(back(47.4), now: now), "47h")
    XCTAssertEqual(Words.age("2026-10-27T12:00:05Z", now: now), "0m", "a time ahead of this phone's clock reads 0m, not a negative age")
    XCTAssertEqual(Words.age("2026-10-27T11:00:20Z", now: now), "1h")
    XCTAssertEqual(Words.age("2026-10-27T11:00:40.000Z", now: now), "59m")
    XCTAssertEqual(Words.age(nil, now: now), "")
  }

  func testAgoAndSince() {
    XCTAssertEqual(Words.ago(back(47.6), now: now), "2d ago")
    XCTAssertEqual(Words.ago("2026-10-27T11:59:20Z", now: now), "40s ago")
    XCTAssertEqual(Words.ago("2026-10-27T12:00:05Z", now: now), "0s ago")
    XCTAssertEqual(Words.ago("2026-10-27T11:55:00Z", now: now), "5m ago")
    XCTAssertEqual(Words.sinceText("2026-10-27T11:59:30Z", now: now), "just now")
    XCTAssertEqual(Words.sinceText("2026-10-27T11:20:00Z", now: now), "40m")
  }

  func testWhen() {
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    utc.locale = Locale(identifier: "en_US")
    XCTAssertEqual(Words.when("2026-10-27T14:30:00Z", now: now, calendar: utc), "14:30")
    XCTAssertEqual(Words.when("2026-10-27T09:05:00.000Z", now: now, calendar: utc), "9:05")
    XCTAssertEqual(Words.when("2026-10-31T09:00:00Z", now: now, calendar: utc), "Sat 9:00")
    XCTAssertEqual(Words.when("2026-11-12T09:00:00Z", now: now, calendar: utc), "Nov 12 9:00")
  }

  func testRefsAndNames() throws {
    XCTAssertEqual(try card().shortRef, "seer#9085")
    XCTAssertEqual(Words.fromName("Inbox coordinator"), "Your agent")
    XCTAssertEqual(Words.fromName("Inbox coordinator", start: false), "your agent")
    XCTAssertEqual(Words.fromName("Review Desk coordinator"), "Your agent", "its name before the rename to Inbox")
    XCTAssertEqual(Words.fromName("sentry: rollout"), "sentry: rollout")
    XCTAssertEqual(Words.capitalized("asked by name"), "Asked by name")
    XCTAssertEqual(Words.plural(1, "comment"), "1 comment")
    XCTAssertEqual(Words.plural(4, "comment"), "4 comments")
  }

  func testClearedText() throws {
    XCTAssertEqual(Words.clearedText(try card(#""status":"snoozed","snooze_until":null"#)), "snoozed until activity")
    XCTAssertEqual(Words.clearedText(try card(#""status":"muted""#)), "muted")
    XCTAssertEqual(Words.clearedText(try card(#""status":"done""#)), "done until someone else acts")
    XCTAssertEqual(Words.clearedText(try card(#""status":"snoozed","snooze_when":"ci""#)), "snoozed until CI passes")
    XCTAssertEqual(Words.clearedText(try card(#""status":"active""#)), "")
    let timed = Words.clearedText(try card(#""status":"snoozed","snooze_until":"2026-10-31T09:00:00Z""#), now: now)
    XCTAssertTrue(timed.hasPrefix("snoozed until ") && timed.hasSuffix(":00 or new activity"), timed)
  }

  // The times, Until activity, then what the item can wait on, in the desk's order.
  func testSnoozeOptions() throws {
    let options = SnoozeOption.all(try card(#""wake_on":["ci","push"]"#))
    XCTAssertEqual(
      options.map(\.label),
      ["1 hour", "3 hours", "Tomorrow 9:00", "Monday 9:00", "Until activity", "Until CI passes", "Until new commits"])
    XCTAssertEqual(options.map(\.until), ["1h", "3h", "tomorrow", "monday", "activity", "ci", "push"])
    XCTAssertEqual(options[0].toast, "for an hour (or until new activity)")
    XCTAssertEqual(options[5].toast, "until CI passes")
    XCTAssertEqual(SnoozeOption.all(try card()).count, 5)
  }

  func testEventText() throws {
    let event = { (json: String) in try DeskJSON.decoder().decode(ActivityEvent.self, from: Data(json.utf8)) }
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"reviewed","actor":"alice","data":{"state":"approved"}}"#), me: "me"), "alice approved")
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"reviewed","actor":"Me","data":{"state":"changes_requested"}}"#), me: "me"), "you requested changes")
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"ci","actor":"","data":{"from":"green","to":"red"}}"#), me: "me"), "CI went red")
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"pushed","actor":"","data":{}}"#), me: "me"), "new commits")
    XCTAssertEqual(
      Words.eventText(try event(#"{"kind":"review_requested","actor":"priya","data":{"reviewer":"backend","type":"team","codeowner":true}}"#), me: "me"),
      "priya asked @backend")
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"review_requested","actor":"priya","data":{"reviewer":"me","type":"user"}}"#), me: "me"), "priya asked you")
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"conflict","actor":"","data":{"base":"main"}}"#), me: "me"), "conflicts with main")
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"unblocked","actor":"","data":{"was":"x","merged":"api#12"}}"#), me: "me"), "unblocked: api#12 merged")
    XCTAssertEqual(Words.eventText(try event(#"{"kind":"teleported","actor":"x"}"#), me: "me"), "teleported", "an event this app doesn't know reads as its kind")
  }

  // An item's recent activity leaves out what its why already says, in its words or in others for the same thing.
  func testAWhySaysAFact() {
    XCTAssertTrue(Words.says("Assigned to you", "assigned to you"))
    XCTAssertTrue(Words.says("red CI on your PR", "CI went red"))
    XCTAssertTrue(Words.says("conflicts with main", "merge conflict"))
    XCTAssertTrue(Words.says("you requested changes", "dana requested changes"))
    XCTAssertTrue(Words.says("2 approvals", "alice approved"))
    XCTAssertFalse(Words.says("assigned to you", "nina commented"))
    XCTAssertFalse(Words.says("", "nina commented"))
    XCTAssertFalse(Words.says("asked you directly", "CI went red"))
    XCTAssertFalse(Words.says("a credible plan", "CI went red"), "red inside a word isn't red")
  }

  func testTheInboxCountsWhatNeedsYou() throws {
    let q: QueueView = try Fixture.decode("queue")
    // Urgent and Standard, the questions and the sessions; FYI and notes aren't counted.
    XCTAssertEqual(Lists.inboxCount(q), 12 + 13 + 2 + 2)
    XCTAssertEqual(Lists.inboxCount(q, leaving: ["acme/api#4127", "session:5f1c2a90-7d3e-4b8a-9c11-2e6f0a4b7d21"]), 27)
  }

  // The one list the client sorts: what you finished and what resolved, newest first.
  func testTheArchive() throws {
    let q: QueueView = try Fixture.decode("queue")
    let archive = Lists.archive(q)
    XCTAssertEqual(archive.count, 4)
    let times = archive.map { $0.resolvedAt ?? $0.doneAt ?? "" }
    XCTAssertEqual(times, times.sorted(by: >))
    XCTAssertEqual(Lists.cleared(q).count, 9)
    XCTAssertEqual(Lists.archiveNote(archive.first { $0.resolved == nil }!), "done: back when someone else acts")
    XCTAssertEqual(Lists.hiddenNote(try card()), "hidden by your rules")
  }

  func testNotices() throws {
    XCTAssertTrue(Notices.of(Conditions()).isEmpty, "nothing is said while all is well")

    let local = Notices.of(Conditions(offline: true, local: true, overview: nil))
    XCTAssertEqual(local.map(\.title), ["The desk isn't running"])
    XCTAssertEqual(local[0].text, "Start it with `desk serve` or open the desktop app.")
    XCTAssertEqual(local[0].fixLabel, "Retry")
    let away = Notices.of(Conditions(offline: true))
    XCTAssertEqual(away.map(\.title), ["The desk can't be reached"])
    XCTAssertEqual(away[0].text?.contains("Tailscale"), true)

    let overview = { (json: String) in try DeskJSON.decoder().decode(Overview.self, from: Data(json.utf8)) }
    let failed = Notices.of(Conditions(overview: try overview(#"{"sync_error":"GitHub: 502 Bad Gateway","syncing":true,"connectors":[{"status":"error"}]}"#)))
    XCTAssertEqual(failed.map(\.title), ["Sync failed"])
    XCTAssertEqual(failed[0].text, "GitHub: 502 Bad Gateway")
    XCTAssertEqual(failed[0].fixLabel, "Syncing…")
    XCTAssertTrue(failed[0].busy)
    XCTAssertEqual(failed[0].tone, .red)

    let limited = Notices.of(
      Conditions(overview: try overview(#"{"sync_error":"rate limited","connectors":[{"status":"paused"}],"rate_limit":{"remaining":0,"reset_at":"2026-10-27T14:30:00Z"}}"#)),
      now: now)
    XCTAssertEqual(limited.map(\.title), ["GitHub's rate limit is used up"])
    XCTAssertEqual(limited[0].tone, .amber)
    XCTAssertNil(limited[0].fix, "a retry would only seem to run")
    XCTAssertEqual(limited[0].text?.hasPrefix("Syncing starts again at "), true)

    let rules = Notices.of(Conditions(overview: try overview(#"{"config_errors":[{"path":"a","message":"b"},{"path":"c","message":"d"}]}"#)))
    XCTAssertEqual(rules.map(\.title), ["Your rules have 2 errors"])
    XCTAssertEqual(Notices.of(Conditions(broken: "config has errors: boards[0]: nope")).first?.text, "There's nothing on your desk until they do. boards[0]: nope")

    let paused = try DeskJSON.decoder().decode(QueueView.Paused.self, from: Data(#"{"who":"claude","why":"Claude Code isn't logged in."}"#.utf8))
    XCTAssertEqual(Notices.of(Conditions(paused: paused, agent: "Codex")).map(\.title), ["Codex is paused"])
    // While the desk is unreachable, what it said last is stale: only that it's down is said.
    XCTAssertEqual(Notices.of(Conditions(offline: true, paused: paused)).count, 1)
    XCTAssertEqual(Notices.of(Conditions(starting: "desk is starting; the first sync can take a minute")).map(\.title), ["The desk is starting"])

    // A read the desk refused: its words, and alone, since what it said before is stale.
    let refused = Notices.of(Conditions(refused: "forbidden host", paused: paused))
    XCTAssertEqual(refused.map(\.title), ["Can't read the desk"])
    XCTAssertEqual(refused[0].text, "Forbidden host.")
    XCTAssertEqual(refused[0].tone, .red)
    XCTAssertEqual(Notices.of(Conditions(offline: true, refused: "forbidden host")).map(\.title), ["The desk can't be reached"])
  }

  func testProseSplitsAtLinks() {
    let parts = Prose.urls("See https://github.com/a/b/pull/12#r1, and (https://example.com/x). Done")
    XCTAssertEqual(parts.map(\.0), ["See ", "https://github.com/a/b/pull/12#r1", ", and (", "https://example.com/x", "). Done"])
    XCTAssertEqual(parts.map(\.1), [false, true, false, true, false])
    XCTAssertEqual(InquiryPage.place("https://www.github.com/me/notes-app/pull/12#discussion_r1"), "github.com/me/notes-app/pull/12#discussion_r1")
  }
}
