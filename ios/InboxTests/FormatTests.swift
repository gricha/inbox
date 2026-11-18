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
    XCTAssertEqual(Words.age(back(45 * 24), now: now), "45d")
    XCTAssertEqual(Words.age(back(46 * 24), now: now), "1mo", "past 45 days, months")
    XCTAssertEqual(Words.age(back(200 * 24), now: now), "6mo")
  }

  // web/test/view.test.ts: "checks: shards of one check are one row with its worst dot, what's wrong first; one alone keeps its whole name".
  func testCheckGroups() {
    let c = { (name: String, state: String, optional: Bool) in Checks.Check(name: name, state: state, optional: optional, url: "") }
    let groups = CheckGroup.of([
      c("backend test (0)", "passing", false),
      c("backend test (1)", "running", false),
      c("backend test (2)", "passing", false),
      c("lint", "passing", false),
      c("acceptance [1/2]", "failing", false),
      c("acceptance [2/2]", "skipped", false),
      c("codecov", "failing", true),
      c("docs", "skipped", false),
    ])
    XCTAssertEqual(groups.map(\.name), ["acceptance", "codecov", "backend test", "lint", "docs"])
    XCTAssertEqual(groups.map(\.dot), [.red, .amber, .yellow, .green, .grey])
    XCTAssertEqual(groups.map(\.checks.count), [2, 1, 3, 1, 1])
    XCTAssertEqual(CheckDot(c("x", "cancelled", false)), .red)
    XCTAssertEqual(groups.map(\.dot.words), ["failing", "failing, not required", "running", "passing", "skipped"])

    // The other marks a shard goes by, one alone keeping its whole name, and a name that is only a mark.
    let names = { (list: [String]) in CheckGroup.of(list.map { c($0, "passing", false) }).map(\.name) }
    XCTAssertEqual(names(["e2e #1", "e2e #2", "unit 1", "unit 2", "it shard 1 of 5", "it Shard 2 of 5", "db 1/2", "db 2/2"]), ["e2e", "unit", "it", "db"])
    XCTAssertEqual(names(["e2e (chromium)", "e2e (firefox)", "lint"]), ["e2e", "lint"])
    XCTAssertEqual(names(["unit tests (1/3)"]), ["unit tests (1/3)"])
    XCTAssertEqual(names(["(1)", "42"]), ["(1)", "42"])
    XCTAssertEqual(names(["b", "a"]), ["b", "a"], "as the desk listed them within a dot")
    XCTAssertTrue(CheckGroup.of([]).isEmpty)
  }

  // The mock's eleven checks are seven rows: past six, the passing and skipped wait behind one line.
  func testAFixturesChecksFold() throws {
    let r: ReviewView = try Fixture.decode("review")
    let groups = CheckGroup.of(try XCTUnwrap(r.checks).list)
    XCTAssertEqual(groups.map(\.name), ["build", "codecov/patch", "e2e", "lint", "typecheck", "unit tests", "visual diff", "deploy preview"])
    XCTAssertEqual(groups.first { $0.name == "unit tests" }?.checks.count, 3)
    XCTAssertTrue(groups.count > CheckGroup.rows)
    XCTAssertTrue(groups.allSatisfy(\.dot.quiet), "all passing or skipped: opened, it shows its one line until Show more")
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
    // Your agent, the session asks go to, is the desk's own too (types.ts's AGENT_NAME).
    XCTAssertTrue(Words.isCoordinator("Inbox agent"))
    XCTAssertEqual(Words.fromName("Inbox agent"), "Your agent")
    XCTAssertFalse(Words.isCoordinator("Inbox agents"))
    XCTAssertFalse(Words.isCoordinator(nil))
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
  // web/test/view.test.ts: "the filter's people: author: and involves: as pills once a space follows, matched as you type them".
  func testTheFiltersPeople() throws {
    let parsed = Filter.parse("author:dana fix involves:@pri")
    XCTAssertEqual(parsed.terms, [Filter.Term(key: "author", who: "dana", done: true), Filter.Term(key: "involves", who: "pri", done: false)])
    XCTAssertEqual(parsed.text, "fix")
    XCTAssertEqual(Filter.rest("author:dana fix involves:pri"), "fix involves:pri")
    XCTAssertEqual(Filter.rest("Author:dana "), "")
    XCTAssertEqual(Filter.of([Filter.Term(key: "author", who: "dana")], "fix "), "author:dana fix ")
    XCTAssertEqual(Filter.parse("AUTHOR:Dana ").terms, [Filter.Term(key: "author", who: "Dana", done: true)], "the key in any case")
    XCTAssertEqual(Filter.parse("label:bug http://x").text, "label:bug http://x", "any other word with a colon is text")
    XCTAssertEqual(Filter.rest("  fix  the bug "), "fix  the bug ", "as typed")

    let card = { (id: String, more: String) in
      let repo = String(id.split(separator: "#")[0])
      let json = #"{"id":"\#(id)","kind":"pr","repo":"\#(repo)","number":\#(id.split(separator: "#")[1]),"title":"A PR"\#(more)}"#
      return try DeskJSON.decoder().decode(Card.self, from: Data(json.utf8))
    }
    let rows = [
      try card("acme/api#1", #","author":"dana","by":"dana","people":["dana","priya"]"#),
      try card("acme/api#7", #","author":"renovate[bot]","author_bot":true,"by":"priya","people":["priya","marco"]"#),
      try card("acme/web#8", #","author":"me","by":"you","people":["me","dana"]"#),
    ]
    let ids = { (f: String) in rows.filter { Filter.matches($0, f, me: "me") }.map(\.id) }
    XCTAssertEqual(ids("author:dana "), ["acme/api#1"])
    XCTAssertEqual(ids("author:pri"), ["acme/api#7"], "a bot's PR is by whom it was opened for")
    XCTAssertEqual(ids("involves:dana "), ["acme/api#1", "acme/web#8"])
    XCTAssertEqual(ids("involves:marco api#7"), ["acme/api#7"], "with words too")
    XCTAssertEqual(ids("author:you "), ["acme/web#8"])
    XCTAssertEqual(ids("author:me"), ["acme/web#8"])
    XCTAssertEqual(ids("involves:you "), ["acme/web#8"])
    XCTAssertEqual(ids("involves:"), ["acme/api#1", "acme/api#7", "acme/web#8"], "a key with no one yet filters nothing")
    XCTAssertEqual(ids("author:@DANA"), ["acme/api#1"], "a leading @ dropped, any case")
    XCTAssertEqual(ids("WEB"), ["acme/web#8"], "the repo")
    XCTAssertEqual(ids("renovate"), ["acme/api#7"], "the author")
    XCTAssertEqual(ids("api#7"), ["acme/api#7"], "the short ref")
    XCTAssertEqual(ids("a pr"), ["acme/api#1", "acme/api#7", "acme/web#8"], "the title")
    XCTAssertEqual(ids("   "), ["acme/api#1", "acme/api#7", "acme/web#8"])
    XCTAssertEqual(ids("nothing"), [])
    // With no people listed, its author is who's on it.
    let bare = try card("acme/api#9", #","author":"kai","by":"kai""#)
    XCTAssertTrue(Filter.matches(bare, "involves:kai", me: "me"))
    XCTAssertFalse(Filter.matches(bare, "involves:dana", me: "me"))

    XCTAssertEqual(
      Filter.people(rows, me: "me"),
      [
        Filter.Person(login: "me", author: true), Filter.Person(login: "dana", author: true), Filter.Person(login: "priya", author: true),
        Filter.Person(login: "marco", author: false),
      ], "you first, as PeopleFilter.tsx's")

    let note = try DeskJSON.decoder().decode(Note.self, from: Data(#"{"id":"n1","text":"Ask Priya about the planner"}"#.utf8))
    XCTAssertTrue(Filter.matches(note, " PRIYA "))
    XCTAssertTrue(Filter.matches(note, ""))
    XCTAssertFalse(Filter.matches(note, "author:priya "), "a note has only its words")
  }

  // Filter.tsx's suggest(), pick() and drop().
  func testWhatTheFilterSuggests() {
    let people = ["dana", "priya", "marco", "me", "daniel", "dan-b", "danielle"].map { Filter.Person(login: $0, author: $0 != "marco" && $0 != "danielle") }
    let pick = { (key: String, login: String) in Filter.Pick(key: key, login: login) }
    XCTAssertEqual(Filter.suggest("", people), [pick("author", ""), pick("involves", "")], "an empty box: the two keys")
    XCTAssertEqual(Filter.suggest("pri", people), [pick("author", "priya"), pick("involves", "priya")])
    XCTAssertEqual(Filter.suggest("@MAR", people), [pick("involves", "marco")], "someone who wrote none is only involved")
    XCTAssertEqual(
      Filter.suggest("dan", people).map(\.id),
      ["author:dana", "author:daniel", "author:dan-b", "involves:dana", "involves:daniel", "involves:dan-b", "involves:danielle"], "four people at most")
    XCTAssertEqual(Filter.suggest("author:", people).map(\.login), ["dana", "priya", "me", "daniel", "dan-b"], "who wrote a row")
    XCTAssertEqual(Filter.suggest("involves:", people).count, 7)
    XCTAssertEqual(Filter.suggest("Involves:@da", people).map(\.login), ["dana", "daniel", "dan-b", "danielle"])
    let many = (1...12).map { Filter.Person(login: "p\($0)", author: true) }
    XCTAssertEqual(Filter.suggest("author:", many).count, 8)

    XCTAssertEqual(Filter.offered("", people).count, 2)
    XCTAssertEqual(Filter.offered("author:dana ", people).count, 2, "after a pill, the keys again")
    XCTAssertEqual(Filter.offered("fix ", people), [], "words typed and none being typed: nothing")
    XCTAssertEqual(Filter.offered("fix pri", people).map(\.id), ["author:priya", "involves:priya"])
    XCTAssertEqual(Filter.offered("zzz", people), [])

    XCTAssertEqual(Filter.picked(pick("author", ""), in: ""), "author:")
    XCTAssertEqual(Filter.picked(pick("author", "dana"), in: "author:"), "author:dana ")
    XCTAssertEqual(Filter.picked(pick("involves", "priya"), in: "author:dana fix pri"), "author:dana involves:priya fix ")
    XCTAssertEqual(Filter.picked(pick("involves", ""), in: "author:dana fix "), "author:dana fix involves:")
    XCTAssertEqual(Filter.dropped(from: "author:dana involves:priya fix"), "author:dana fix")
    XCTAssertEqual(Filter.dropped(0, from: "author:dana involves:priya fix"), "involves:priya fix")
    XCTAssertEqual(Filter.dropped(from: "fix"), "fix", "no pill to take off")
    XCTAssertEqual(Filter.word("fix pri"), "pri")
    XCTAssertEqual(Filter.word("fix "), "")
  }

  // Avatar.tsx: a person's picture is asked of GitHub by their login alone; none for you or a bot that wrote its own PR.
  @MainActor
  func testWhosePictureARowShows() throws {
    XCTAssertEqual(Avatar.url("dana")?.absoluteString, "https://avatars.githubusercontent.com/dana?s=40")
    XCTAssertEqual(Avatar.url("@ana-k")?.absoluteString, "https://avatars.githubusercontent.com/ana-k?s=40")
    XCTAssertEqual(Avatar.url("acme-junior[bot]")?.absoluteString, "https://avatars.githubusercontent.com/acme-junior%5Bbot%5D?s=40")
    XCTAssertNil(Avatar.url(""))
    XCTAssertNil(Avatar.url("you/../x"))
    XCTAssertNil(Avatar.url("a b"))
    XCTAssertNil(Avatar.url("acme/reviewers"), "a team has none")
    let card = { (more: String) in
      try DeskJSON.decoder().decode(Card.self, from: Data(#"{"id":"a/b#1","kind":"pr","repo":"a/b","number":1,"title":"t"\#(more)}"#.utf8))
    }
    XCTAssertEqual(try card(#","author":"dana","by":"dana""#).face, "dana")
    XCTAssertNil(try card(#","author":"me","by":"you""#).face, "none for you")
    XCTAssertNil(try card(#","author":"dependabot[bot]","author_bot":true,"by":"dependabot[bot]""#).face, "a bot's own PR")
    XCTAssertEqual(try card(#","author":"acme-junior[bot]","author_bot":true,"by":"dana""#).face, "dana", "a bot's PR opened for dana")
    XCTAssertNil(try card(#","author":"acme-junior[bot]","author_bot":true,"by":"you""#).face)
  }

  func testABotsPRSaysWhoItWasOpenedForViaTheBot() throws {
    let card = { (more: String) in
      try DeskJSON.decoder().decode(
        Card.self, from: Data(#"{"id":"a/b#1","kind":"pr","repo":"a/b","number":1,"title":"t","author":"sentry-junior","author_bot":true\#(more)}"#.utf8))
    }
    let dana = try card(#","by":"dana","attribution":{"person":"@dana","agent":"sentry-junior","source":"line"}"#)
    XCTAssertEqual([dana.byWords, dana.face], ["dana via sentry-junior", "dana"])
    let named = try card(#","by":"Dana Q","attribution":{"person":"Dana Q","agent":"sentry-junior","source":"model"}"#)
    XCTAssertEqual(named.byWords, "Dana Q via sentry-junior")
    XCTAssertNil(named.face, "a name alone has no picture")
    let mine = try card(#","by":"you","attribution":{"person":"@me","agent":"sentry-junior","source":"line"}"#)
    XCTAssertEqual(mine.byWords, "you via sentry-junior")
    let nobody = try card(#","by":"sentry-junior","attribution":{"person":"","agent":"sentry-junior","source":"none"}"#)
    XCTAssertEqual(nobody.byWords, "sentry-junior")
    XCTAssertNil(nobody.face)
    XCTAssertEqual(try card(#","by":"sentry-junior""#).byWords, "sentry-junior", "a desk from before attribution")
    let standing = { (who: String) in try DeskJSON.decoder().decode(Standings.Standing.self, from: Data(#"{"who":"\#(who)","state":"asked"}"#.utf8)).face }
    XCTAssertEqual(try standing("marco"), "marco")
    XCTAssertNil(try standing("you"))
    XCTAssertNil(try standing("@ml-team"), "a team has none")
  }

  // Note.tsx's WHEN, and what goes to /api/notes as `remind`.
  func testANotesReminder() throws {
    XCTAssertEqual(Remind.choices.map(\.label), ["No reminder", "In 1 hour", "In 3 hours", "Tomorrow 9:00", "Monday 9:00", "Pick a time…"])
    let at = try XCTUnwrap(Words.date("2026-11-16T09:30:00.000Z"))
    for pick in ["", "1h", "3h", "tomorrow", "monday"] { XCTAssertEqual(Remind.value(pick, at: at), pick) }
    XCTAssertEqual(Remind.value("pick", at: at), "2026-11-16T09:30:00.000Z", "as JavaScript's toISOString()")
    // Left where it was, it goes back as the desk sent it; moved, as the new time.
    let note = try DeskJSON.decoder().decode(Note.self, from: Data(#"{"id":"n1","text":"t","remind_at":"2026-11-16T09:30:00Z"}"#.utf8))
    XCTAssertEqual(Remind.value("pick", at: at, was: note), "2026-11-16T09:30:00Z")
    XCTAssertEqual(Remind.value("pick", at: at.addingTimeInterval(60), was: note), "2026-11-16T09:31:00.000Z")
    XCTAssertEqual(Remind.value("", at: at, was: note), "", "No reminder takes it off")
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
    XCTAssertEqual(Remind.nextHour(try XCTUnwrap(Words.date("2026-11-16T09:30:10.000Z")), calendar: utc), Words.date("2026-11-16T10:00:00.000Z"))
  }

  // A note's menu moves it one section up or down; a due reminder counts as Urgent (RowMenu.tsx's NoteMenu).
  func testANotesMoves() throws {
    let now = try XCTUnwrap(Words.date("2026-11-16T12:00:00Z"))
    let note = { (more: String) in try DeskJSON.decoder().decode(Note.self, from: Data(#"{"id":"n1","text":"t"\#(more)}"#.utf8)) }
    XCTAssertEqual(Lists.moves(try note(""), now: now), ["urgent", "fyi"], "none is Standard")
    XCTAssertEqual(Lists.moves(try note(#","section":"standard""#), now: now), ["urgent", "fyi"])
    XCTAssertEqual(Lists.moves(try note(#","section":"urgent""#), now: now), ["standard"])
    XCTAssertEqual(Lists.moves(try note(#","section":"fyi""#), now: now), ["standard"])
    XCTAssertEqual(Lists.moves(try note(#","section":"fyi","remind_at":"2026-11-16T11:00:00Z""#), now: now), ["standard"], "due: it leads Urgent")
    XCTAssertEqual(Lists.moves(try note(#","section":"fyi","remind_at":"2026-11-16T13:00:00Z""#), now: now), ["standard"], "to come: where it's put")
    XCTAssertEqual(Lists.moves(try note(#","remind_at":"2026-11-16T11:00:00Z""#), now: now), ["standard"])
  }

  // format.ts's sizeOf(): a PR's size by the lines it changes.
  func testAPRsSize() {
    XCTAssertEqual(Words.sizeOf(add: 20, del: 9).bars, 1)
    XCTAssertEqual(Words.sizeOf(add: 20, del: 10).bars, 2)
    XCTAssertEqual(Words.sizeOf(add: 62, del: 7).label, "Small change: +62 \u{2212}7")
    XCTAssertEqual(Words.sizeOf(add: 400, del: 199).label, "Medium change: +400 \u{2212}199")
    XCTAssertEqual(Words.sizeOf(add: 600, del: 0).label, "Large change: +600 \u{2212}0")
    XCTAssertEqual(Words.sizeOf(add: 0, del: 0).label, "Tiny change: +0 \u{2212}0")
  }

  // format.ts's issueUrl(): what a question is about, when the desk doesn't hold its card. Nothing for what isn't an id.
  func testAnItemOnGitHubByItsId() {
    XCTAssertEqual(Words.issueURL("acme/api#4127")?.absoluteString, "https://github.com/acme/api/issues/4127")
    XCTAssertEqual(Words.issueURL("me/notes-app.v2#12")?.absoluteString, "https://github.com/me/notes-app.v2/issues/12")
    XCTAssertNil(Words.issueURL("acme/api"))
    XCTAssertNil(Words.issueURL("acme/api#x"))
    XCTAssertNil(Words.issueURL("evil.example/a/b#1"))
    XCTAssertNil(Words.issueURL("a b/c#1"))
  }

  // web/test/view.test.ts: "treeGuides draws Blocked's tree from its depths: a branch with more under it, its last, the
  // line past a deeper row, none".
  func testBlockedsTreeGuides() throws {
    // web#1; web#2 and web#3 under it, web#4 under web#3 and web#5 under web#2; then a chain of its own.
    XCTAssertEqual(Lists.treeGuides([0, 1, 2, 1, 2, 0, 1]), [[], [.tee], [.rail, .end], [.end], [.gap, .end], [], [.end]])
    XCTAssertEqual(Lists.treeGuides([0, 0]), [[], []], "rows of their own draw nothing")
    XCTAssertEqual(Lists.treeGuides([]), [])
    let q: QueueView = try Fixture.decode("queue")
    let drawn = Lists.treeGuides((q.sections?.blocked ?? []).map { $0.depth ?? 0 })
    XCTAssertEqual(Array(drawn[2...4]), [[], [.end], [.gap, .end]], "billing#2300, #2302 under it, #2303 under that")
    XCTAssertEqual(Array(drawn[7...10]), [[], [.tee], [.end], [.gap, .end]], "web#2306 with two under it, the second with one of its own")
  }

  // RowMenu.tsx's MOVES: one section up or down, for an active card on the Inbox.
  func testWhereARowCanMove() throws {
    let card = { (more: String) in
      try DeskJSON.decoder().decode(Card.self, from: Data(#"{"id":"a/b#1","kind":"pr","repo":"a/b","number":1,"title":"t"\#(more)}"#.utf8))
    }
    XCTAssertEqual(Lists.moves(try card(#","section":"urgent","status":"active""#)), ["standard"])
    XCTAssertEqual(Lists.moves(try card(#","section":"standard","status":"active""#)), ["urgent", "fyi"])
    XCTAssertEqual(Lists.moves(try card(#","section":"fyi","status":"active""#)), ["standard"])
    XCTAssertEqual(Lists.moves(try card(#","status":"active""#)), [], "not on the Inbox")
    XCTAssertEqual(Lists.moves(try card(#","section":"standard","status":"snoozed""#)), [])
    XCTAssertEqual(Lists.moves(try card(#","section":"standard","status":"active","inflight":true"#)), [], "in Merging")
    XCTAssertEqual(Lists.moves(try card(#","section":"someday","status":"active""#)), [], "a newer desk's section")
    let q: QueueView = try Fixture.decode("queue")
    XCTAssertEqual(q.inbox?.urgent.first.map(Lists.moves), ["standard"])
    XCTAssertEqual(q.inbox?.fyi.first?.section, "fyi")
    XCTAssertNil(q.sections?.blocked.first?.section)
  }

  // Queue.tsx's cut: five of seven, all of six, all once asked or while filtering.
  func testFYIShowsItsFirstFive() {
    XCTAssertEqual(Lists.fyiCut(7, all: false, filtering: false), 5)
    XCTAssertEqual(Lists.fyiCut(40, all: false, filtering: false), 5)
    XCTAssertNil(Lists.fyiCut(6, all: false, filtering: false), "one row is never hidden alone")
    XCTAssertNil(Lists.fyiCut(5, all: false, filtering: false))
    XCTAssertNil(Lists.fyiCut(7, all: true, filtering: false))
    XCTAssertNil(Lists.fyiCut(7, all: false, filtering: true))
  }

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
    XCTAssertEqual(local[0].text, "Start it with `inbox serve` or open the desktop app.")
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

  // Ask your agent in an item's More: never on a blocked author's issue (no agent reads their items) or a resolved one.
  func testAskYourAgentIsNotOfferedOnABlockedAuthorsIssue() throws {
    let queue: QueueView = try Fixture.decode("queue")
    let cards = (queue.inbox?.urgent ?? []) + (queue.inbox?.standard ?? []) + (queue.inbox?.fyi ?? [])
    let issue = try XCTUnwrap(cards.first { !$0.isPR })
    XCTAssertTrue(Asking.offered(issue, blockedAuthor: nil, landed: true))
    XCTAssertTrue(Asking.offered(issue, blockedAuthor: false, landed: true))
    XCTAssertFalse(Asking.offered(issue, blockedAuthor: true, landed: true))
    XCTAssertFalse(Asking.offered(issue, blockedAuthor: nil, landed: false), "not before the desk has said whose it is")
    var done = issue
    done.resolved = "closed"
    XCTAssertFalse(Asking.offered(done, blockedAuthor: false, landed: true))
    XCTAssertTrue(Asking.offered(try XCTUnwrap(cards.first { $0.isPR }), blockedAuthor: nil, landed: false), "a PR's review has it")
  }

  // A review's stack list, as the window's StackList: open PRs and the one on screen, four around it and "N more".
  func testALongStackShowsFourAroundThisPR() throws {
    func stack(_ states: [String], forks: [String] = []) throws -> Stack {
      let member = { (i: Int, s: String) in #"{"id":"a/b#\#(i)","number":\#(i),"title":"t","state":"\#(s)"}"# }
      let line = states.enumerated().map { member($0.offset + 1, $0.element) }.joined(separator: ",")
      let other = forks.enumerated().map { member($0.offset + 100, $0.element) }.joined(separator: ",")
      return try DeskJSON.decoder().decode(Stack.self, from: Data(#"{"base":"main","line":[\#(line)],"forks":[\#(other)]}"#.utf8))
    }
    // PR 3 of 20, the first two merged: 18 open, four from this one, "14 more".
    let long = try stack(["merged", "merged"] + Array(repeating: "open", count: 18), forks: ["open", "closed"])
    var got = long.around("a/b#3", all: false)
    XCTAssertEqual(got.line.map(\.number), [3, 4, 5, 6])
    XCTAssertEqual(got.more, 14)
    XCTAssertEqual(got.forks.map(\.number), [100], "other branches: the open ones")
    got = long.around("a/b#10", all: false)
    XCTAssertEqual(got.line.map(\.number), [9, 10, 11, 12], "the one below it first")
    XCTAssertEqual(long.around("a/b#20", all: false).line.map(\.number), [17, 18, 19, 20])
    XCTAssertEqual(long.around("a/b#3", all: true).line.count, 18)
    // A merged PR's own page still lists it.
    XCTAssertEqual(long.around("a/b#1", all: true).line.count, 19)
    // Five open: one would hide, so none does.
    let short = try stack(Array(repeating: "open", count: 5))
    XCTAssertEqual(short.around("a/b#1", all: false).line.count, 5)
    XCTAssertEqual(short.around("a/b#1", all: false).more, 0)
  }

  // A resolved PR's line names who merged or closed it, from its activity (view.ts's resolvedHead()).
  func testAResolvedPRSaysWhoMergedIt() throws {
    let events = try DeskJSON.decoder().decode(
      [ActivityEvent].self, from: Data(#"[{"seq":2,"kind":"commented","actor":"dana"},{"seq":1,"kind":"merged","actor":"li-wei"}]"#.utf8))
    XCTAssertEqual(Words.resolvedHead(events, "merged", me: "me"), "merged by li-wei")
    XCTAssertEqual(Words.resolvedHead(events, "merged", me: "Li-Wei"), "merged by you")
    XCTAssertEqual(Words.resolvedHead(events, "closed", me: "me"), "closed", "nobody to name")
    XCTAssertEqual(Words.resolvedHead(events, "approved by dana", me: "me"), "approved by dana")
    XCTAssertEqual(Words.resolvedHead([], "no longer requested", me: "me"), "no longer requested")
  }

  // An issue's page says where it sits and from which board, and why it moved from where the rule put it (Detail.tsx).
  func testWhereAnIssueSitsAndWhyItMoved() throws {
    let overview: Overview = try Fixture.decode("overview")
    XCTAssertEqual(overview.boardLabel("work-review"), "PRs to review")
    XCTAssertEqual(overview.boardLabel("gone"), "gone")
    func detail(_ card: String, _ placement: String) throws -> ItemDetail {
      let json = #"{"card":{"id":"a/b#1","kind":"issue","repo":"a/b","number":1,"title":"t","board":"work-review"\#(card)},"placements":[{"board":"other","bucket":"hide"},\#(placement)]}"#
      return try DeskJSON.decoder().decode(ItemDetail.self, from: Data(json.utf8))
    }
    let board = { overview.boardLabel($0) }
    // The card's why says it all: nothing more.
    var p = Words.placement(try detail(#","why":"assigned to you""#, #"{"board":"work-review","bucket":"now","rule_bucket":"now","why":"assigned to you","judge":{"bucket":"today","why":""}}"#), board: board, agent: "Claude")
    XCTAssertNil(p.place)
    XCTAssertNil(p.moved)
    // Sorted by your agent, with another why, then capped down.
    p = Words.placement(
      try detail(#","why":"new activity""#, #"{"board":"work-review","bucket":"fyi","rule_bucket":"today","why":"mentions you","demoted":"The AI says skip it","judge":{"bucket":"today","why":"small"}}"#),
      board: board, agent: "Claude")
    XCTAssertEqual((p.place ?? "") + p.rest, "FYI, from the PRs to review board, sorted by Claude: mentions you")
    XCTAssertEqual(p.moved, "Claude said today; it moved to fyi because the AI says skip it.")
    // A rule's place, moved by a cap; resolved says Otherwise; an automation is named.
    p = Words.placement(
      try detail(#","why":"x","resolved":"closed""#, #"{"board":"work-review","bucket":"today","rule_bucket":"now","why":"x","demoted":"3 from PRs to review are urgent already"}"#),
      board: board, agent: "Claude")
    XCTAssertEqual((p.place ?? "") + p.rest, "Otherwise In the Inbox, from the PRs to review board")
    XCTAssertEqual(p.moved, "The rule said now; it moved to today because 3 from PRs to review are urgent already.")
    p = Words.placement(
      try detail("", #"{"board":"work-review","bucket":"later","rule_bucket":"later","demoted":"quiet","judge":{"bucket":"later","why":"w","by":"triage"}}"#), board: board, agent: "Claude")
    XCTAssertEqual((p.place ?? "") + p.rest, "Later, from the PRs to review board, sorted by automation triage")
    XCTAssertEqual(p.moved, "Automation triage said later; it moved to later because quiet.")
  }

  // An opened page's one call to action: the row's own first, then what the item is there for.
  func testAPagesCallToAction() throws {
    let queue: QueueView = try Fixture.decode("queue")
    let cards = (queue.inbox?.urgent ?? []) + (queue.inbox?.standard ?? []) + (queue.inbox?.fyi ?? [])
    let act = { (id: String) in cards.first { $0.id == id }?.act(open: true) }
    XCTAssertEqual(act("acme/api#4127"), "approve", "someone else's PR")
    XCTAssertEqual(act("me/notes-app#12"), "reply", "the row's own call to action wins")
    XCTAssertEqual(act("acme/web#2303"), "ready")
    XCTAssertEqual(act("acme/worker#875"), "handoff", "yours, approved")
    XCTAssertEqual(act("acme/worker#860"), "comment", "an issue")
    XCTAssertNil(act("acme/api#4154"), "yours with changes requested: nothing to press but More")
    XCTAssertNil(cards.first { $0.id == "acme/api#4127" }?.act(open: false), "closed or merged")
    // An open PR the desk resolved is still yours to approve, as the window's review: only GitHub's state closes it.
    let resolved = try XCTUnwrap(queue.resolved.first { $0.isPR && !$0.mine && $0.resolved == "no longer requested" })
    XCTAssertEqual(resolved.act(open: true), "approve", resolved.resolved ?? "")
    XCTAssertNil(resolved.act(open: false))
    for key in ["ready", "reviewers", "reply", "approve", "comment", "handoff"] { XCTAssertNotNil(Words.act[key], key) }
    XCTAssertEqual(Words.act["ready"], Words.cta["ready"], "a row's call to action keeps the row's words")
    // Your ready PR's row asks to hand it off; a cta this app doesn't know falls back to what the item is there for.
    let row = { (cta: String) in
      try DeskJSON.decoder().decode(Card.self, from: Data(#"{"id":"me/a#1","kind":"pr","repo":"me/a","number":1,"title":"t","by":"you","review":"approved","cta":"\#(cta)"}"#.utf8))
    }
    XCTAssertEqual(try row("handoff").act(open: true), "handoff")
    XCTAssertEqual(Words.act["handoff"], "Hand off for merge")
    XCTAssertEqual(try row("merge").act(open: true), "handoff", "an older desk's merge: Hand off for merge")
  }

  // An issue's page: what kind its pre-review says it is, who placed it and how you were asked (Detail.tsx).
  func testAnIssuesWords() throws {
    XCTAssertEqual(Words.issueKind("bug"), "A bug")
    XCTAssertEqual(Words.issueKind("feature"), "A feature request")
    XCTAssertEqual(Words.issueKind("question"), "A question")
    XCTAssertEqual(Words.issueKind("other"), "An issue")
    XCTAssertEqual(Words.issueKind(nil), "An issue")
    XCTAssertEqual(Words.issueKind("epic"), "An issue", "a kind a newer desk has")
    XCTAssertEqual(Words.act["fix"], "Make PR with fix")

    XCTAssertEqual(Words.placedBy("claude", agent: "Codex"), "sorted by Codex")
    XCTAssertEqual(Words.placedBy("hard", agent: "Claude"), "placed by a hard rule")
    XCTAssertEqual(Words.placedBy("pin", agent: "Claude"), "kept up by its pin")
    XCTAssertEqual(Words.placedBy("automation", agent: "Claude"), "sorted by an automation")
    XCTAssertNil(Words.placedBy(nil, agent: "Claude"))

    typealias Me = ItemDetail.Signals.Me
    XCTAssertEqual(Words.asked(Me(assignee: true, requested: false)), "assigned to you")
    XCTAssertEqual(Words.asked(Me(requested: false)), "not requested")
    XCTAssertEqual(Words.asked(Me(author: true)), "your PR")
    XCTAssertEqual(
      Words.asked(Me(requested: true, requestedDirect: true, requestedCodeowner: true, requestedBy: "dana", requestedByBot: false, requestedHours: 3.4)),
      "you, by name, by dana, CODEOWNERS, 3h ago")
    XCTAssertEqual(
      Words.asked(Me(requested: true, requestedDirect: false, requestedTeam: "acme/api", requestedBy: "triage", requestedByBot: true, requestedHours: 0.5)),
      "your team @acme/api, by triage (bot), 30m ago")
    XCTAssertEqual(Words.asked(Me(requested: true, requestedDirect: true, requestedBy: "", requestedHours: 72)), "you, by name, 3d ago")
    XCTAssertEqual(Words.asked(Me(requested: true, requestedDirect: true, requestedHours: -1)), "you, by name")

    let d: ItemDetail = try Fixture.decode("item-issue")
    XCTAssertTrue(Words.says(d.card.why ?? "", Words.asked(try XCTUnwrap(d.signals?.me))), "its why already says it")
  }

  // What reviewers said: where a conversation is, its words, who a reply answers and your agent's take (Conversation.tsx).
  func testAConversationsWords() throws {
    func convo(_ json: String) throws -> Conversation { try DeskJSON.decoder().decode(Conversation.self, from: Data(json.utf8)) }
    XCTAssertEqual(Words.place(try convo(#"{"id":"a","path":"src/auth.ts","line":42}"#)), "src/auth.ts:42")
    XCTAssertEqual(Words.place(try convo(#"{"id":"a","path":"src/auth.ts","line":42,"outdated":true}"#)), "src/auth.ts:42, outdated")
    XCTAssertEqual(Words.place(try convo(#"{"id":"a","path":"src/auth.ts","line":null,"outdated":true}"#)), "src/auth.ts, outdated")
    XCTAssertEqual(Words.place(try convo(#"{"id":"a","kind":"comment","path":null}"#)), "on the PR")

    let bot = "### Possible null dereference\n\n`local` may be undefined.\n\n<details><summary>Evidence</summary>\n\n- `merge()` reads it\n\n</details>\n\n<sub>Found by bugbot</sub>\n<!-- finding:v1 -->"
    XCTAssertEqual(
      Words.saidText(bot), "Possible null dereference\n\n`local` may be undefined.\n\nEvidence\n\n- `merge()` reads it\n\nFound by bugbot",
      "no tags, no comments, code kept")
    XCTAssertEqual(Words.saidText("if a < b && c > d then #1"), "if a < b && c > d then #1", "not every angle is a tag")

    let read = try convo(#"{"id":"a","comments":[{"id":"1","author":"dana","body":"Long.\nMore."}],"take":{"gist":"The gist","take":"x"}}"#)
    let unread = try convo(#"{"id":"a","comments":[{"id":"1","author":"dana","body":"First."},{"id":"2","author":"kai","body":"Last line.\nMore."}]}"#)
    XCTAssertEqual(Words.replyTo("Reply", unread, me: "me"), "Reply to kai")
    XCTAssertEqual(Words.replyTo("Reply", unread, me: "Kai"), "Reply to dana", "not to yourself, when you spoke last")
    XCTAssertEqual(Words.replyTo("Sent your reply", read, me: "dana"), "Sent your reply", "your own thread: nobody to name")

    var take = Words.takeSplit("Valid concern: nothing prunes it: see `merge()`")
    XCTAssertEqual(take.call, "Valid concern")
    XCTAssertEqual(take.rest, "nothing prunes it: see `merge()`", "only the first one splits")
    take = Words.takeSplit("Nothing to do here")
    XCTAssertNil(take.call, "no call: all plain")
    XCTAssertEqual(take.rest, "Nothing to do here")
    take = Words.takeSplit("At 10:30 it ran")
    XCTAssertNil(take.call, "a colon inside a word isn't one")
  }

  // MARK: Ask your agent (Chat.tsx)

  private func coordinator(_ json: String) throws -> InflightView.Coordinator {
    try DeskJSON.decoder().decode(InflightView.Coordinator.self, from: Data(json.utf8))
  }

  // What your agent is doing about an ask it hasn't answered, in the window's order: the first that holds wins.
  func testTheWaitingLinePerState() throws {
    XCTAssertEqual(Wait(ask: "a1", live: nil), .answer)
    XCTAssertEqual(Wait(ask: "a1", live: nil).words, "Waiting for its answer")
    XCTAssertNil(Wait(ask: "a1", live: nil).link)
    let url = #""url":"https://claude.ai/code/session_01""#
    let table: [(String, Wait, String, String?, Bool)] = [
      // An error wins over everything else it says.
      (#"{"on":true,\#(url),"error":"claude isn't logged in","status":"waiting","queued":["a1"],"activity":["Read app.py"]}"#, .cantRun("claude isn't logged in"),
        "It can't run: claude isn't logged in", nil, false),
      (#"{"on":true,\#(url),"error":null,"status":"waiting","queued":["a1"],"activity":["Read app.py"]}"#, .permission, "Waiting on a permission prompt",
        "Answer it on claude.ai", false),
      (#"{"on":true,\#(url),"error":null,"status":"busy","queued":["a1"],"activity":["Read app.py"]}"#, .queued,
        "Queued: it gets this when it's done with what it's on", "Watch it on claude.ai", true),
      (#"{"on":true,\#(url),"error":null,"status":"busy","queued":["other"],"activity":["Read app.py","Searched for idempotency_key"]}"#,
        .step("Searched for idempotency_key"), "Searched for idempotency_key", "Watch it on claude.ai", true),
      (#"{"on":true,\#(url),"error":null,"status":"shell","queued":[],"activity":["Ran the tests"]}"#, .step("Ran the tests"), "Ran the tests", "Watch it on claude.ai", true),
      (#"{"on":true,\#(url),"error":null,"status":"busy","queued":[],"activity":[]}"#, .onIt, "On it", "Watch it on claude.ai", true),
      (#"{"on":true,\#(url),"error":null,"status":"shell"}"#, .onIt, "On it", "Watch it on claude.ai", true),
      // Its steps are only what it's doing while it works.
      (#"{"on":true,\#(url),"error":null,"status":"idle","queued":[],"activity":["Read app.py"]}"#, .stopped, "It stopped without answering", "Watch it on claude.ai", false),
      (#"{"on":true,\#(url),"error":null,"status":"stopped","queued":[],"activity":[]}"#, .stopped, "It stopped without answering", "Watch it on claude.ai", false),
      (#"{"on":true,"id":null,"url":null,"error":null,"status":null}"#, .stopped, "It stopped without answering", "Watch it on claude.ai", false),
      // An older desk says nothing of what it's doing.
      (#"{"on":true,"id":"4be71c2a","url":null,"error":null}"#, .stopped, "It stopped without answering", "Watch it on claude.ai", false),
    ]
    for (json, wait, words, link, busy) in table {
      let w = Wait(ask: "a1", live: try coordinator(json))
      XCTAssertEqual(w, wait, json)
      XCTAssertEqual(w.words, words, json)
      XCTAssertEqual(w.link, link, json)
      XCTAssertEqual(w.busy, busy, json)
    }
    // The mock's: busy, with its latest step.
    let mock: AsksView = try Fixture.decode("asks")
    XCTAssertEqual(Wait(ask: "b7d3e410", live: mock.coordinator), .step("Searched for idempotency_key"))
  }

  // Its words are on screen above the step line: a step they already hold (whitespace folded, less a trailing …) reads On it.
  func testTheStepLineHidesWhatItSaid() throws {
    let live = { (step: String, saying: String) in
      try self.coordinator(#"{"on":true,"error":null,"status":"busy","queued":[],"activity":["Read app.py",\#(String(decoding: try JSONEncoder().encode(step), as: UTF8.self))],"saying":\#(String(decoding: try JSONEncoder().encode(saying), as: UTF8.self))}"#)
    }
    let saying = "The retry wraps the whole handler, so a second\nwebhook can double-charge.\n\nChecking the key next."
    XCTAssertEqual(Wait(ask: "a1", live: try live("The retry wraps the whole handler, so a second webhook can double-charge.", saying)), .onIt)
    XCTAssertEqual(Wait(ask: "a1", live: try live("Checking the key next\u{2026}", saying)), .onIt)
    XCTAssertEqual(Wait(ask: "a1", live: try live("Searched for idempotency_key", saying)), .step("Searched for idempotency_key"))
    XCTAssertEqual(Wait(ask: "a1", live: try live("Read app.py", "")), .step("Read app.py"), "nothing said yet")
    let mock: AsksView = try Fixture.decode("asks")
    XCTAssertEqual(Wait.said("Searched for idempotency_key", in: mock.coordinator?.saying ?? ""), false)
    XCTAssertEqual(Wait.said("Checking how the idempotency key is read", in: mock.coordinator?.saying ?? ""), true)
  }

  // How each agent runs, as the chat's menus offer it (Chat.tsx's AGENT): its name, its words, its models and efforts.
  func testTheAgentTable() {
    let claude = AgentKind.of("claude-code")
    XCTAssertEqual(claude.name, "Claude Code")
    XCTAssertEqual(claude.run, ["Ask first", "Bypass permissions"])
    XCTAssertEqual(claude.models(""), [
      .init(value: "", label: "Default model"), .init(value: "claude-fable-5-2", label: "Fable 5.2"),
      .init(value: "claude-opus-5-5", label: "Opus 5.5"), .init(value: "claude-sonnet-5-5", label: "Sonnet 5.5"),
      .init(value: "claude-haiku-5-5", label: "Haiku 5.5"),
    ])
    XCTAssertEqual(claude.efforts("").map(\.label), ["Default effort", "Low", "Medium", "High", "Xhigh", "Max"])
    XCTAssertEqual(AgentKind.of(nil), claude, "an older desk names none: Claude Code")
    let codex = AgentKind.of("codex")
    XCTAssertEqual([codex.name] + codex.run, ["Codex", "Workspace only", "Full access"])
    XCTAssertEqual(codex.models("").map(\.label), ["Default model"])
    XCTAssertEqual(codex.efforts("high").map(\.label), ["Default effort", "Low", "Medium", "High", "Xhigh"])
    let opencode = AgentKind.of("opencode")
    XCTAssertEqual([opencode.name] + opencode.run, ["OpenCode", "Refuse what asks", "Approve what asks"])
    XCTAssertTrue(opencode.efforts.isEmpty, "no effort menu on OpenCode")
    // A typed model is listed as typed, after the ones it knows; a trigger says a word for the default.
    let typed = claude.models("claude-opus-4-5")
    XCTAssertEqual(typed.last, .init(value: "claude-opus-4-5", label: "claude-opus-4-5"))
    XCTAssertEqual(AgentKind.said(typed, value: "claude-opus-4-5", none: "Model"), "claude-opus-4-5")
    XCTAssertEqual(AgentKind.said(typed, value: "claude-opus-5-5", none: "Model"), "Opus 5.5")
    XCTAssertEqual(AgentKind.said(typed, value: "", none: "Model"), "Model")
    XCTAssertEqual(AgentKind.said(codex.efforts("high"), value: "high", none: "Effort"), "High")
  }

  // Each agent's mark is drawn from the window's path in its 24×24 box.
  func testTheAgentMarks() {
    for agent in ["claude-code", "codex", "opencode"] {
      let box = AgentMark(agent: agent).path(in: CGRect(x: 0, y: 0, width: 24, height: 24)).boundingRect
      XCTAssertGreaterThanOrEqual(box.width, 16, agent)
      XCTAssertGreaterThanOrEqual(box.height, 15, agent)
      XCTAssertTrue(CGRect(x: -0.01, y: -0.01, width: 24.02, height: 24.02).contains(box), "\(agent): \(box)")
    }
    XCTAssertEqual(AgentMark(agent: "claude-code").path(in: CGRect(x: 0, y: 0, width: 24, height: 24)).boundingRect, CGRect(x: 0, y: 5, width: 24, height: 15))
    // Codex's arcs reach its round edge on every side.
    let codex = AgentMark(agent: "codex").path(in: CGRect(x: 0, y: 0, width: 24, height: 24)).boundingRect
    XCTAssertEqual(codex.minX, 0, accuracy: 0.2)
    XCTAssertEqual(codex.maxX, 24, accuracy: 0.2)
    XCTAssertEqual(codex.minY, 0, accuracy: 0.2)
    XCTAssertEqual(codex.maxY, 24, accuracy: 0.2)
    // Opencode's: an outer frame with a hole; the hole is even-odd, so its centre isn't filled.
    let opencode = AgentMark(agent: "opencode").path(in: CGRect(x: 0, y: 0, width: 24, height: 24))
    XCTAssertTrue(opencode.contains(CGPoint(x: 5, y: 12), eoFill: true))
    XCTAssertFalse(opencode.contains(CGPoint(x: 12, y: 12), eoFill: true))
  }

  // Under your words: when, the item, and where in it.
  func testAnAsksMetaLine() throws {
    let ask = { (more: String) in
      try DeskJSON.decoder().decode(Ask.self, from: Data(#"{"id":"a1","at":"\#(self.back(3))","text":"t"\#(more)}"#.utf8))
    }
    XCTAssertEqual(Asking.meta(try ask(""), now: now, agent: "Claude"), ["3h"])
    XCTAssertEqual(Asking.meta(try ask(#","item_id":"me/notes-app#12","thread_id":null,"thread_url":null"#), now: now, agent: "Claude"), ["3h", "notes-app#12"])
    XCTAssertEqual(
      Asking.meta(try ask(#","item_id":"me/notes-app#12","thread_id":"PRRT_1","thread_url":"https://github.com/me/notes-app/pull/12#discussion_r2""#), now: now, agent: "Claude"),
      ["3h", "notes-app#12", "on a thread"])
    let head = #""head":"0000000000000000000000000000000000000001""#
    XCTAssertEqual(
      Asking.meta(try ask(#","item_id":"acme/api#4127","lines":{"path":"src/planner/plan.ts","line":23,"side":"new","start":{"line":20,"side":"new"},\#(head)}"#), now: now, agent: "Claude"),
      ["3h", "api#4127", "on plan.ts:20\u{2013}23"])
    XCTAssertEqual(
      Asking.meta(try ask(#","item_id":"acme/api#4127","lines":{"path":"plan.ts","line":7,"side":"old",\#(head)}"#), now: now, agent: "Claude").last, "on plan.ts:7, removed")
    XCTAssertEqual(
      Asking.meta(try ask(#","item_id":"acme/api#4127","lines":{"path":"a/plan.ts","line":7,"side":"new","note":true,\#(head)}"#), now: now, agent: "Codex").last,
      "on Codex's note on plan.ts:7")
    // Mixed sides read as the new file's lines: only an all-removed range says so.
    XCTAssertEqual(Asking.linesLabel(path: "plan.ts", line: 9, side: "old", start: (7, "new")), "plan.ts:7\u{2013}9")
    XCTAssertEqual(Asking.linesLabel(path: "plan.ts", line: 9, side: "old", start: (7, "old")), "plan.ts:7\u{2013}9, removed")
    let fresh = try DeskJSON.decoder().decode(Ask.self, from: Data(#"{"id":"a2","at":"\#(back(0.005))","text":"t"}"#.utf8))
    XCTAssertEqual(Asking.meta(fresh, now: now, agent: "Claude"), ["just now"])
    XCTAssertEqual(Asking.shortId("me/notes-app#12"), "notes-app#12")
    XCTAssertEqual(Asking.placeholder("acme/api#4127"), "Ask or tell it something about api#4127")
    XCTAssertEqual(Asking.placeholder(nil), "Ask or tell it something")
    XCTAssertEqual(Asking.off, "Your agent is off in Settings → Agent, so nothing is sent.")
  }

  // What an ask from a conversation or a line carries, and the x's one step wider.
  func testWhatTheChatIsAbout() throws {
    let review: ReviewView = try Fixture.decode("review-own")
    let c = try XCTUnwrap(review.conversation.first { ($0.path ?? "").isEmpty == false })
    let about = ChatAbout.thread("me/notes-app#12", c)
    XCTAssertEqual(about.thread?.id, c.id)
    XCTAssertEqual(about.thread?.url, c.url)
    XCTAssertEqual(about.spot, "\(c.comments.first?.author ?? "")'s \(c.kind ?? "") on \(Words.place(c))")
    XCTAssertEqual(about.wider, ChatAbout(item: "me/notes-app#12"))
    XCTAssertEqual(about.wider.wider, ChatAbout())
    let line = ChatAbout(item: "acme/api#4127", lines: .init(path: "src/planner/plan.ts", line: 23, side: "old", head: String(repeating: "0", count: 40)))
    XCTAssertEqual(line.spot, "plan.ts:23, removed")
    XCTAssertNil(ChatAbout(item: "acme/api#4127").spot)
  }

  // MARK: <agent>'s work (Inflight.tsx's WorkRow)

  private func work(_ json: String) throws -> Work {
    try DeskJSON.decoder().decode(Work.self, from: Data(#"{"title":"Queue: a leases table","queued_at":"\#(back(2))",\#(json)}"#.utf8))
  }

  func testAWorkRowsPhrasePerStateKindAndAttempts() throws {
    let ahead = ISO8601DateFormatter().string(from: now.addingTimeInterval(120))
    let late = "no answer in 5 minutes, so it was stopped"
    let table: [(String, [String])] = [
      (#""kind":"ai_review","key":"a/b#1","state":"running","attempts":1"#, ["Claude is reviewing it"]),
      (#""kind":"ai_review","key":"a/b#1","state":"running","attempts":2,"error":"\#(late)""#, ["Claude is reviewing it", "try 2 of 3"]),
      (#""kind":"ask","key":"a1","state":"running","attempts":1"#, ["Your agent has it"]),
      (#""kind":"ask","key":"a1","state":"running","attempts":3"#, ["Your agent has it", "try 3 of 3"]),
      (#""kind":"ai_review","key":"a/b#1","state":"queued","attempts":0"#, ["Waiting its turn"]),
      (#""kind":"ask","key":"a1","state":"queued","attempts":0"#, ["Waiting for your agent"]),
      (#""kind":"ai_review","key":"a/b#1","state":"queued","attempts":1,"retry_at":"\#(ahead)","error":"\#(late)""#, ["Tries again in 2m", late]),
      (#""kind":"ai_review","key":"a/b#1","state":"queued","attempts":1,"retry_at":"\#(back(0.1))","error":"\#(late)""#, ["Tries again shortly", late]),
      (#""kind":"ai_review","key":"a/b#1","state":"failed","attempts":1,"error":"\#(late)""#, ["Failed: \(late)"]),
      (#""kind":"ai_review","key":"a/b#1","state":"failed","attempts":3,"error":"\#(late)""#, ["Failed 3 times: \(late)"]),
      // An ask never counts its tries.
      (#""kind":"ask","key":"a1","state":"failed","attempts":3,"error":"your agent didn't start""#, ["Failed: your agent didn't start"]),
      (#""kind":"answer","key":"q1","state":"failed","attempts":0,"from":"seer: code mode research","error":"that session has probably ended""#,
        ["Your answer to seer: code mode research hasn't been picked up", "that session has probably ended"]),
      (#""kind":"answer","key":"q1","state":"queued","attempts":0,"from":"Inbox coordinator""#, ["Your answer to your agent hasn't been picked up"]),
    ]
    for (json, phrase) in table { XCTAssertEqual(Asking.workPhrase(try work(json), agent: "Claude", now: now), phrase, json) }
    XCTAssertEqual(Asking.workPhrase(try work(#""kind":"ai_review","key":"a/b#1","state":"running","attempts":1"#), agent: "Codex", now: now), ["Codex is reviewing it"])
  }

  // Your ask's words in quotes; since when; and Try again only on a failed review or ask.
  func testAWorkRowsTitleAgeAndTryAgain() throws {
    XCTAssertEqual(Asking.workTitle(try work(#""kind":"ai_review","key":"a/b#1""#)), "Queue: a leases table")
    XCTAssertEqual(Asking.workTitle(try work(#""kind":"ask","key":"a1""#)), "\u{201C}Queue: a leases table\u{201D}")
    XCTAssertEqual(Asking.workTitle(try work(#""kind":"answer","key":"q1""#)), "Queue: a leases table")
    let times = #""started_at":"\#(back(1))","finished_at":"\#(back(0.5))""#
    XCTAssertEqual(Asking.workSince(try work(#""kind":"ai_review","key":"a/b#1","state":"running",\#(times)"#)), back(1))
    XCTAssertEqual(Asking.workSince(try work(#""kind":"ai_review","key":"a/b#1","state":"failed",\#(times)"#)), back(0.5))
    XCTAssertEqual(Asking.workSince(try work(#""kind":"ai_review","key":"a/b#1","state":"queued",\#(times)"#)), back(2))
    XCTAssertEqual(Asking.workSince(try work(#""kind":"ai_review","key":"a/b#1","state":"running""#)), back(2), "not started yet: since it was queued")
    XCTAssertEqual(Asking.workSince(try work(#""kind":"answer","key":"q1","state":"failed",\#(times)"#)), back(2), "an answer: since you gave it")
    XCTAssertTrue(Asking.canRetry(try work(#""kind":"ai_review","key":"a/b#1","state":"failed""#)))
    XCTAssertTrue(Asking.canRetry(try work(#""kind":"ask","key":"a1","state":"failed""#)))
    XCTAssertFalse(Asking.canRetry(try work(#""kind":"answer","key":"q1","state":"failed""#)), "only the session that asked can read it")
    XCTAssertFalse(Asking.canRetry(try work(#""kind":"ai_review","key":"a/b#1","state":"running""#)))
    // The mock's five, as Merging says them.
    let mock: InflightView = try Fixture.decode("inflight")
    XCTAssertEqual(mock.work.map { Asking.workPhrase($0, agent: "Claude", now: now).first }, [
      "Claude is reviewing it", "Claude is reviewing it", "Your agent has it", "Failed 3 times: no answer in 5 minutes, so it was stopped",
      "Your answer to seer: code mode research hasn't been picked up",
    ])
    XCTAssertEqual(mock.work.filter(Asking.canRetry).map(\.key), ["acme/worker#890"])
  }

  // MARK: An agent's words as blocks (src/prose.ts)

  // What a reviewer wrote, as the window's saidBlocks(): a <details> is a fold, <sub> small print, a fence a block.
  func testWhatAReviewerWroteAsBlocks() {
    let t = { (s: String) in Span(text: s) }
    let body = "<!-- bot -->\n### Findings\n\n<details>\n<summary><b>2 issues</b> found</summary>\n\n- one\n- two\n\n```suggestion\nlet a = <b>1</b>\n```\n\n</details>\n\nSee https://example.com<br>now.\n\n<sub>Reviewed by a bot</sub>"
    XCTAssertEqual(
      Blocks.said(body),
      [
        .block(.p([Span(text: "Findings", bold: true)])),
        .details(
          summary: [Span(text: "2 issues", bold: true), t(" found")],
          blocks: [.block(.ul([[t("one")], [t("two")]])), .block(.pre(text: "let a = <b>1</b>", info: "suggestion"))]),
        .block(.p([t("See "), Span(text: "https://example.com", link: "https://example.com"), t("\nnow.")])),
        .small([t("Reviewed by a bot")]),
      ])
    XCTAssertEqual(Blocks.said("<details>plain</details>"), [.details(summary: [t("Details")], blocks: [.block(.p([t("plain")]))])])
    XCTAssertEqual(Blocks.said("a <kbd>k</kbd>"), [.block(.p([t("a <kbd>k</kbd>")]))], "any other tag stays text")
    XCTAssertEqual(Blocks.said(""), [])
  }

  // A reviewer's links and images, as saidBlocks() with labels: a link is its words, an image its alt, nothing raw HTML.
  func testWhatAReviewerWroteLinksAndImages() {
    let t = { (s: String) in Span(text: s) }
    let link = { (s: String, url: String) in Span(text: s, link: url) }
    XCTAssertEqual(
      Blocks.said("See [the notes](https://github.com/acme/api/wiki) and ![lgtm](https://media.example.com/a.gif)."),
      [.block(.p([t("See "), link("the notes", "https://github.com/acme/api/wiki"), t(" and "), Span(text: "lgtm", link: "https://media.example.com/a.gif", image: true), t(".")]))])
    XCTAssertEqual(
      Blocks.said(#"Learn about <a href="https://vercel.com/docs">Vercel <span>for</span> GitHub</a>."#),
      [.block(.p([t("Learn about "), link("Vercel for GitHub", "https://vercel.com/docs"), t(".")]))], "an <a>'s words, its tags gone")
    XCTAssertEqual(
      Blocks.said(#"<a href="https://preview.app"><img alt="Visit Preview" src="https://vercel.com/button"></a>"#),
      [.block(.p([link("Visit Preview", "https://preview.app")]))], "a linked image is a link in its alt")
    XCTAssertEqual(
      Blocks.said(#"<picture><source media="(prefers-color-scheme: dark)" srcset="https://x/d.svg"><img alt="Coverage" src="https://x/l.svg"></picture>"#),
      [.block(.p([Span(text: "Coverage", link: "https://x/l.svg", image: true)]))], "a <picture>'s image")
    XCTAssertEqual(Blocks.said(#"<img src="https://x/a.png">"#), [.block(.p([Span(text: "image", link: "https://x/a.png", image: true)]))], "no alt: image")
    XCTAssertEqual(Blocks.said("Details: https://vercel.com/acme/4127."), [.block(.p([t("Details: "), link("https://vercel.com/acme/4127", "https://vercel.com/acme/4127"), t(".")]))])
    XCTAssertEqual(Blocks.said(#"<a href="http://x.com">plain</a> [no](http://x.com)"#), [.block(.p([t(#"<a href="http://x.com">plain</a> [no](http://x.com)"#)]))], "only https")
    XCTAssertEqual(Blocks.said("[spoof](https://github.com@evil.com/)"), [.block(.p([t("[spoof](https://github.com@evil.com/)")]))], "no userinfo")
    XCTAssertEqual(Blocks.said(#"<div align="center"><em>hi</em></div>"#), [.block(.p([t("hi")]))], "a tag's attributes go with it")
    XCTAssertEqual(Blocks.said("`<a href=\"https://x.y\">k</a>`"), [.block(.p([Span(text: #"[k](https://x.y)"#, code: true)]))], "code is code")
    XCTAssertEqual(Blocks.parse("[the PR](https://x.y/1)"), [.p([t("the PR (https://x.y/1)")])], "your agent's words keep the URL in sight")
    XCTAssertEqual(Blocks.saidLine("<!-- x -->\n### Possible bug\n\nmore"), "Possible bug")
    XCTAssertEqual(Blocks.saidLine(#"See <a href="https://x.y">the run</a>"#), "See the run")
    XCTAssertEqual(Blocks.saidLine(""), "")
  }

  // Status's words and thresholds, the window's (Review.tsx's checksState(), changesWord()).
  func testStatusWords() {
    let check = { (state: String) in Checks.Check(name: state, state: state) }
    XCTAssertEqual(Status.checks(Checks(failing: true, list: Lossy(wrappedValue: [check("failing")]))).said, "Checks failing")
    XCTAssertEqual(Status.checks(Checks(failing: false, list: Lossy(wrappedValue: [check("passing"), check("cancelled")]))).said, "Some checks failing")
    XCTAssertEqual(Status.checks(Checks(failing: false, list: Lossy(wrappedValue: [check("passing"), check("failing")]))).tone, .warn, "an optional one failing")
    XCTAssertEqual(Status.checks(Checks(failing: false, list: Lossy(wrappedValue: [check("running"), check("passing")]))).said, "Checks running")
    XCTAssertEqual(Status.checks(Checks(failing: false, list: Lossy(wrappedValue: [check("passing"), check("skipped")]))).said, "Checks passing")
    XCTAssertEqual(Status.changes(add: 60, del: 40, files: 5), "Small changes", "100 lines in 5 files is small")
    XCTAssertEqual(Status.changes(add: 60, del: 41, files: 5), "Moderate changes")
    XCTAssertEqual(Status.changes(add: 10, del: 0, files: 6), "Moderate changes", "more than 5 files")
    XCTAssertEqual(Status.changes(add: 600, del: 0, files: 20), "Moderate changes")
    XCTAssertEqual(Status.changes(add: 600, del: 1, files: 20), "Lots of changes")
    XCTAssertEqual(Status.changes(add: 1, del: 0, files: 21), "Lots of changes")
    XCTAssertEqual(Status.risk("medium"), "Medium risk")
    XCTAssertEqual([Status.riskBars("high"), Status.riskBars("medium"), Status.riskBars("low")], [1, 2, 4])
    XCTAssertEqual(Status.reviewerAct(who: "sam", state: "asked", draft: false), "remove")
    XCTAssertEqual(Status.reviewerAct(who: "sam", state: "changes requested", draft: false), "rerequest")
    XCTAssertNil(Status.reviewerAct(who: "sam", state: "approved", draft: true), "a draft asks nobody again")
    XCTAssertNil(Status.reviewerAct(who: "sam", state: "approved", again: true, draft: false), "already asked again")
    XCTAssertNil(Status.reviewerAct(who: "@backend", state: "asked", draft: false), "a team's ask is the team's")
    XCTAssertNil(Status.reviewerAct(who: "you", state: "asked", draft: false))
    XCTAssertEqual(Status.face("you", me: "gricha"), "gricha")
    XCTAssertNil(Status.face("@backend", me: "gricha"))
  }

  func testProseBlocks() {
    let t = { (s: String) in Span(text: s) }
    XCTAssertEqual(Blocks.parse("One line\nstill it.\n\nAnother."), [.p([t("One line\nstill it.")]), .p([t("Another.")])])
    XCTAssertEqual(
      Blocks.parse("Two things:\n\n1. kai's nit (`lamport()` \u{2192} `nextClock()`)\n2. azulus's question\n\nCI is green."),
      [
        .p([t("Two things:")]),
        .ol(start: 1, items: [[t("kai's nit ("), Span(text: "lamport()", code: true), t(" \u{2192} "), Span(text: "nextClock()", code: true), t(")")], [t("azulus's question")]]),
        .p([t("CI is green.")]),
      ])
    XCTAssertEqual(
      Blocks.parse("What I checked:\n- both call sites\n  in `merge.ts`\n* **nothing else is open**, so it's safe"),
      [
        .p([t("What I checked:")]),
        .ul([[t("both call sites\nin "), Span(text: "merge.ts", code: true)], [Span(text: "nothing else is open", bold: true), t(", so it's safe")]]),
      ])
    XCTAssertEqual(Blocks.parse("3. third\n4. fourth"), [.ol(start: 3, items: [[t("third")], [t("fourth")]])])
    // A fenced block keeps its lines and its language; one never closed still shows.
    XCTAssertEqual(
      Blocks.parse("Once, in `replay.ts`:\n\n```ts\nconst at = lamport(state); // **not bold**\n\n  indented\n```\nAfter."),
      [.p([t("Once, in "), Span(text: "replay.ts", code: true), t(":")]), .pre(text: "const at = lamport(state); // **not bold**\n\n  indented", info: "ts"), .p([t("After.")])])
    XCTAssertEqual(Blocks.parse("```\nnpm test"), [.pre(text: "npm test", info: "")])
    XCTAssertEqual(Blocks.parse("```not a language!\nx\n```"), [.pre(text: "x", info: "")])
    XCTAssertEqual(Blocks.parse("```\n\n```"), [], "an empty block is nothing")
    // A heading is a bold paragraph, without its hashes.
    XCTAssertEqual(Blocks.parse("## What's left\nNothing."), [.p([Span(text: "What's left", bold: true)]), .p([t("Nothing.")])])
    // Unpaired marks are text.
    XCTAssertEqual(Blocks.inline("a ** b"), [t("a ** b")])
    XCTAssertEqual(Blocks.inline("**a** and **b"), [Span(text: "a", bold: true), t(" and **b")])
    XCTAssertEqual(Blocks.inline("an odd ` tick"), [t("an odd ` tick")])
    XCTAssertEqual(Blocks.inline("**bold `code`**"), [Span(text: "bold ", bold: true), Span(text: "code", code: true, bold: true)])
    // A URL stays the text it is; a markdown link shows where it goes.
    XCTAssertEqual(Blocks.parse("I can push it: https://github.com/me/notes-app/pull/14"), [.p([t("I can push it: https://github.com/me/notes-app/pull/14")])])
    XCTAssertEqual(Blocks.inline("see [the PR](https://github.com/me/notes-app/pull/14)."), [t("see the PR (https://github.com/me/notes-app/pull/14).")])
    XCTAssertEqual(Blocks.inline("[x](javascript:alert(1))"), [t("[x](javascript:alert(1))")])
    XCTAssertEqual(Blocks.parse(""), [])
    XCTAssertEqual(Blocks.parse("a\r\nb"), [.p([t("a\nb")])])
  }

  // Copy keeps the fence, longer than any backtick run that opens a line inside.
  func testFencedCopy() {
    XCTAssertEqual(Blocks.fencedCopy("const a = 1", info: "ts"), "```ts\nconst a = 1\n```")
    XCTAssertEqual(Blocks.fencedCopy("```\ninner\n```", info: ""), "````\n```\ninner\n```\n````")
    XCTAssertEqual(Blocks.fencedCopy("a ``` b", info: "suggestion"), "```suggestion\na ``` b\n```")
  }

  // The mock's answers, whole: nothing of them is lost to the parse.
  func testTheMocksAnswersParse() throws {
    let v: AsksView = try Fixture.decode("asks")
    let first = Blocks.parse(v.asks[0].answer?.text ?? "")
    XCTAssertEqual(first.count, 3)
    guard case .ol(1, let items) = first[1] else { return XCTFail("a numbered list") }
    XCTAssertEqual(items.count, 2)
    let second = Blocks.parse(v.asks[1].answer?.text ?? "")
    XCTAssertEqual(second.count, 6)
    guard case .ul(let checked) = second[2] else { return XCTFail("a list") }
    XCTAssertEqual(checked.count, 3)
    XCTAssertEqual(checked[2].first, Span(text: "nothing else in kai's thread is open", bold: true))
    XCTAssertEqual(second[4], .pre(text: "const at = lamport(state); // becomes nextClock(state)", info: "ts"))
    XCTAssertEqual(second[5], .p([Span(text: "I can push that fix there once this merges: https://github.com/me/notes-app/pull/14")]))
  }
}
