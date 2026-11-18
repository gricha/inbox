import XCTest

@testable import Inbox

// The guided review's list, where the AI review's notes sit, a diagram as text and the AI review's own words, against
// the mock's guided reviews (Fixtures/review-steps.json, review.json) and the desk's own cases (test/diagram.test.ts).
@MainActor
final class GuideTests: XCTestCase {
  // What the diff's heading lists to go to: the guide's steps, or each file once in reading order, as the window's sidebar.
  func testThePlacesToGoTo() throws {
    let o = try order("review-steps")
    let guided = DiffModel(o, guided: true, bugs: 2)
    XCTAssertEqual(guided.stops.map(\.id), guided.steps.indices.map { "step-\($0)" })
    XCTAssertEqual(guided.stops.map(\.title), guided.steps.map(\.title))
    let plain = DiffModel(o)
    let shown = plain.list.prefix(plain.rest)
    XCTAssertEqual(plain.stops.map(\.path), shown.map(\.path).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }, "each file once")
    XCTAssertEqual(plain.stops.map(\.id), plain.stops.map { stop in shown.first { $0.path == stop.path }?.key }, "at its first section")
    XCTAssertEqual(Set(plain.stops.filter(\.notes).map(\.path)), Set(shown.filter { !$0.notes.isEmpty }.map(\.path)))
    XCTAssertFalse(plain.stops.isEmpty)
  }

  private func order(_ name: String, _ change: ((inout [String: Any]) -> Void)? = nil) throws -> ReviewOrder {
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: try Fixture.data(name)) as? [String: Any])
    var order = try XCTUnwrap(json["order"] as? [String: Any])
    change?(&order)
    json["order"] = order
    let view = try DeskJSON.decoder().decode(ReviewView.self, from: try JSONSerialization.data(withJSONObject: json))
    return try XCTUnwrap(view.order)
  }

  // MARK: walk()

  func testTheWalkIsEachStepsSectionsThenWhatNoStepCovers() throws {
    let w = Diff.walk(try order("review-steps"))
    XCTAssertEqual(w.steps.map(\.title), ["The row stream", "The planner's budget", "The query route", "Tests"])
    XCTAssertEqual(w.steps.map(\.at), [0, 1, 3, 4], "the budget's two hunks are at two levels, so two sections")
    XCTAssertEqual(w.steps[1].check, "One slow batch can't run far past the budget.")
    XCTAssertEqual(w.steps[2].check, "")
    XCTAssertEqual(w.beyond, 5)
    XCTAssertEqual(w.rest, 6)
    XCTAssertEqual(w.list.map(\.key), ["h1", "h2", "h3", "h4", "h5", "h6"])
    XCTAssertEqual(w.list.map(\.level), ["skim", "skip", "look", "look", "skim", "skip"])
    XCTAssertEqual(w.list[3].notes, [2, 3])
    XCTAssertEqual(w.list[2].why, "budget checked only between batches")
  }

  func testNeighboursAtOneLevelForOneReasonAreOneSectionOnlyWithinAFile() throws {
    let w = Diff.walk(try order("review"))
    XCTAssertEqual(w.steps.map(\.at), [0, 3, 10])
    XCTAssertEqual(w.steps.map(\.diagram), ["d1", "d2", ""])
    XCTAssertTrue(w.steps[0].note.hasPrefix("Lease ships first"))
    XCTAssertEqual(w.beyond, 20, "every hunk is its own file's")
    XCTAssertEqual(w.rest, 31)
    // Two hunks of one file, same level and reason, are one section.
    let merged = try order("review-steps") { o in
      var steps = o["steps"] as! [[String: Any]]
      var hunks = steps[1]["hunks"] as! [[String: Any]]
      hunks[0]["level"] = hunks[1]["level"]
      hunks[0]["why"] = hunks[1]["why"]
      steps[1]["hunks"] = hunks
      o["steps"] = steps
    }
    let one = Diff.walk(merged)
    XCTAssertEqual(one.steps.map(\.at), [0, 1, 2, 3])
    XCTAssertEqual(one.list[1].hunks.map(\.id), ["h2", "h3"])
    XCTAssertEqual(one.list[1].key, "h2")
    XCTAssertEqual(one.list[1].notes, [1])
    XCTAssertEqual(one.list[1].rows, Diff.rows(one.list[1].hunks[0].patch ?? "") + Diff.rows(one.list[1].hunks[1].patch ?? ""))
  }

  // MARK: The guided list

  func testTheGuideIsOnlyItsStepsAndCountsTheFilesItLeavesOut() throws {
    let g = Diff.guided(try order("review-steps"), bugs: 2)
    XCTAssertEqual(g.list.map(\.key), ["h1", "h2", "h3", "h4", "h5"])
    XCTAssertEqual(g.beyond, 5)
    XCTAssertEqual(g.left, 1, "docs/api/query.md")
    XCTAssertEqual(Diff.guided(try order("review"), bugs: 1).left, 11)
    let model = DiffModel(try order("review-steps"), guided: true, bugs: 2)
    XCTAssertTrue(model.guiding)
    XCTAssertEqual(model.rest, model.list.count, "no fold: what's left is Code changes'")
    XCTAssertEqual(model.steps.count, 4)
  }

  func testAPotentialBugOutsideTheGuideStillShowsAfterIt() throws {
    let o = try order("review-steps") { o in
      var beyond = o["beyond"] as! [[String: Any]]
      beyond[0]["notes"] = [1]
      o["beyond"] = beyond
    }
    let g = Diff.guided(o, bugs: 2)
    XCTAssertEqual(g.list.map(\.key), ["h1", "h2", "h3", "h4", "h5", "h6"])
    XCTAssertEqual(g.beyond, 5, "the heading goes above the sixth")
    XCTAssertEqual(g.left, 0)
    XCTAssertEqual(Diff.guided(o, bugs: 1).list.count, 5, "note 1 is no concern when there is one concern")
    XCTAssertEqual(Diff.guided(o, bugs: 1).left, 1)
  }

  func testAnOrderWithoutStepsIsCodeChangesWhateverWasChosen() throws {
    let model = DiffModel(try order("review-own"), guided: true)
    XCTAssertFalse(model.guiding)
    XCTAssertEqual(model.steps.count, 0)
  }

  func testCodeChangesCarriesEachFilesNotes() throws {
    let (list, _) = Diff.traditional(try order("review-steps"))
    XCTAssertEqual(list.first { $0.path == "src/routes/query.ts" }?.notes, [2, 3])
    XCTAssertEqual(list.first { $0.path == "docs/api/query.md" }?.notes, [])
  }

  func testATestFileStartsFoldedOnlyInTheGuide() throws {
    for p in ["test/planner/stream.test.ts", "tests/a.py", "src/__tests__/x.tsx", "spec/models/user.rb", "pkg/testing/fake.go", "src/plan.spec.ts", "src/plan_test.go", "test_plan.py", "a/b/plan-tests.js", "Tests/AppTests.swift"] {
      XCTAssertTrue(Diff.isTestPath(p), p)
    }
    for p in ["src/planner/plan.ts", "src/latest.ts", "src/contest/a.ts", "docs/testing.md", "src/test_plan", "src/attest.rs", "inspect/a.go"] {
      XCTAssertFalse(Diff.isTestPath(p), p)
    }
    let o = try order("review-steps")
    let guided = DiffModel(o, guided: true, bugs: 2)
    XCTAssertEqual(guided.list.filter(guided.startsShut).map(\.path), ["test/planner/stream.test.ts"])
    XCTAssertFalse(guided.startsShut(guided.list[1]), "a step's hunk at skip is still the step's to show")
    let plain = DiffModel(o)
    XCTAssertEqual(plain.list.filter(plain.startsShut).count, 0)
  }

  // MARK: Notes on lines

  func testANoteSitsOnItsLineOrAboveItsFile() throws {
    let view: ReviewView = try Fixture.decode("review-steps")
    let notes = try XCTUnwrap(view.ai?.notes)
    let w = Diff.walk(try XCTUnwrap(view.order))
    XCTAssertEqual(Diff.placed(w.list[3], notes).lines, [2, 3])
    XCTAssertEqual(Diff.placed(w.list[3], notes).file, [])
    // Line 0 is about the whole file.
    XCTAssertEqual(Diff.placed(w.list[4], notes).file, [4])
    XCTAssertEqual(Diff.placed(w.list[4], notes).lines, [])
    // Off the hunk, and on the old side.
    var moved = notes
    moved[2].line = 400
    moved[3].side = "old"
    moved[3].line = 27
    let p = Diff.placed(w.list[3], moved)  // @@ -27,11 +27,14 @@
    XCTAssertEqual(p.file, [2])
    XCTAssertEqual(p.lines, [3])
    moved[3].line = 38  // the old side ends at 37
    XCTAssertEqual(Diff.placed(w.list[3], moved).file, [2, 3])
    // A note the review doesn't have is nowhere.
    XCTAssertEqual(Diff.placed(w.list[3], []).file, [])
  }

  func testWhichLineOfTheDiffSomethingIsOn() {
    let lines = patchLines("@@ -5,3 +5,3 @@\n a\n-b\n+c\n d")
    XCTAssertEqual(lines.map { Diff.on($0, line: 6, side: "new") }, [false, false, false, true, false])
    XCTAssertEqual(lines.map { Diff.on($0, line: 6, side: "old") }, [false, false, true, false, false])
    XCTAssertEqual(lines.map { Diff.on($0, line: 5, side: "old") }, [false, true, false, false, false], "an unchanged line is on both sides, a @@ on none")
  }

  func testWhereALineOfAFileIsDrawn() throws {
    let model = DiffModel(try order("review-steps"), guided: true, bugs: 2)
    XCTAssertEqual(model.place(path: "src/routes/query.ts", line: 30, side: "new"), "h4:6", "its row, after the @@ line and what was removed above it")
    XCTAssertEqual(model.place(path: "src/routes/query.ts", line: 900, side: "new"), "h4", "its file's header")
    XCTAssertNil(model.place(path: "docs/api/query.md", line: 20, side: "new"), "outside the guide")
    XCTAssertNotNil(DiffModel(try order("review-steps")).place(path: "docs/api/query.md", line: 20, side: "new"))
  }

  // MARK: A diagram as text (test/diagram.test.ts's graphs, as parseDiagram() makes them)

  private func graph(_ json: String) throws -> DiagramGraph { try DeskJSON.decoder().decode(DiagramGraph.self, from: Data(json.utf8)) }

  func testAFlowIsOneLinePerEdgeWithMarksNamedAndUnlinkedNodesKept() throws {
    let g = try graph(
      #"{"kind":"flow","direction":"LR","nodes":[{"id":"fetch","label":"fetchPr()","shape":"box","mark":null,"group":null},{"id":"prompt","label":"buildPrompt()","shape":"box","mark":null,"group":null},{"id":"check","label":"checkClaims()","shape":"box","mark":"new","group":null},{"id":"old","label":"oldCheck()","shape":"box","mark":"removed","group":null},{"id":"lone","label":"Review page","shape":"box","mark":null,"group":null}],"edges":[{"from":"fetch","to":"prompt","label":"","style":"arrow"},{"from":"prompt","to":"check","label":"claims","style":"arrow"},{"from":"check","to":"old","label":"","style":"line"}],"groups":[]}"#)
    XCTAssertEqual(
      diagramText(g),
      ["fetchPr() → buildPrompt()", "buildPrompt() → checkClaims() (new): claims", "checkClaims() (new) — oldCheck() (removed)", "Review page"])
  }

  func testASequenceIsOneLinePerMessageWithItsNotes() throws {
    let g = try graph(
      #"{"kind":"sequence","participants":[{"id":"D","label":"Desk","actor":false},{"id":"W","label":"Writer","actor":false},{"id":"C","label":"C","actor":false}],"messages":[{"from":"D","to":"W","text":"prompt","reply":false},{"from":"W","to":"D","text":"review","reply":true},{"from":"D","to":"C","text":"","reply":false}],"notes":[{"over":["D"],"text":"first","at":0},{"over":["D","W"],"text":"last","at":3}]}"#)
    XCTAssertEqual(diagramText(g), ["Note over Desk: first", "Desk → Writer: prompt", "Writer → Desk: review", "Desk → C", "Note over Desk, Writer: last"])
    XCTAssertEqual(diagramText(try graph(#"{"kind":"gantt"}"#)), [], "a kind this app doesn't know draws no lines")
  }

  func testTheMocksDiagramsReadAsText() throws {
    let view: ReviewView = try Fixture.decode("review")
    let lines = try XCTUnwrap(view.ai?.diagrams).map { $0.graph.map(diagramText) ?? [] }
    XCTAssertEqual(lines.count, 2)
    XCTAssertTrue(lines.allSatisfy { !$0.isEmpty })
    XCTAssertTrue(lines[0].allSatisfy { $0.contains(" → ") || $0.contains(" — ") }, "\(lines[0])")
  }

  // MARK: The AI review's words

  func testASummaryLeadsWithItsFirstSentence() {
    var l = Words.lead("Adds a streaming scan (`streamRows`) and uses it in `runPlan`. The route passes `?budget=` through.")
    XCTAssertEqual(l.first, "Adds a streaming scan (`streamRows`) and uses it in `runPlan`.")
    XCTAssertEqual(l.rest, "The route passes `?budget=` through.")
    l = Words.lead("Bumps deps, e.g. vite. Nothing else.\n\nSecond paragraph.")
    XCTAssertEqual(l.first, "Bumps deps, e.g. vite.")
    XCTAssertEqual(l.rest, "Nothing else.\n\nSecond paragraph.")
    l = Words.lead("Renames `a.b c` to `d`. Done.")
    XCTAssertEqual(l.first, "Renames `a.b c` to `d`.")
    l = Words.lead("Reads `x. y` as one")
    XCTAssertEqual(l.first, "Reads `x. y` as one", "never cut inside code")
    XCTAssertEqual(l.rest, "")
    l = Words.lead("- one\n- two")
    XCTAssertEqual(l.first, "", "no lead when it opens with a list")
    XCTAssertEqual(l.rest, "- one\n- two")
    XCTAssertEqual(Words.lead("").first, "")
    XCTAssertEqual(Words.lead("Is it safe? (Yes.) Then more.").first, "Is it safe?")
  }

  private func job(_ json: String) throws -> Job { try DeskJSON.decoder().decode(Job.self, from: Data(json.utf8)) }

  func testTheRunningLineSaysHowLongAndWhichTry() throws {
    let now = try XCTUnwrap(Words.date("2026-11-15T09:00:00.000Z"))
    let soon = "Claude is reviewing it. The notes land in the code below in a minute or two."
    XCTAssertEqual(Words.reviewing(agent: "Claude", job: nil, now: now), soon)
    XCTAssertEqual(Words.reviewing(agent: "Claude", job: try job(#"{"state":"running","attempts":1,"started_at":"2026-11-15T08:59:00.000Z"}"#), now: now), soon)
    XCTAssertEqual(
      Words.reviewing(agent: "Claude", job: try job(#"{"state":"running","attempts":1,"started_at":"2026-11-15T08:58:00.000Z"}"#), now: now),
      "Claude is reviewing it, 2 minutes so far.")
    XCTAssertEqual(
      Words.reviewing(agent: "Codex", job: try job(#"{"state":"running","attempts":2,"started_at":"2026-11-15T08:56:10.000Z"}"#), now: now),
      "Codex is reviewing it, 4 minutes so far, try 2 of 3.")
    XCTAssertEqual(
      Words.reviewing(agent: "Claude", job: try job(#"{"state":"running","attempts":3,"started_at":"2026-11-15T08:59:30.000Z"}"#), now: now),
      "Claude is reviewing it, try 3 of 3.")
    // A job that isn't running (queued for a retry) says nothing of itself.
    XCTAssertEqual(Words.reviewing(agent: "Claude", job: try job(#"{"state":"queued","attempts":2,"started_at":"2026-11-15T08:00:00.000Z"}"#), now: now), soon)
  }

  func testAFailedReviewSaysSoAndWhenItTriesAgain() throws {
    let now = try XCTUnwrap(Words.date("2026-11-15T09:00:00.000Z"))
    let late = "no answer in 5 minutes, so it was stopped"
    XCTAssertEqual(
      Words.reviewFailed(late, job: try job(#"{"state":"failed","attempts":3,"error":"\#(late)"}"#), agent: "Claude", now: now),
      "The AI review failed 3 times: no answer in 5 minutes, so it was stopped.")
    XCTAssertEqual(
      Words.reviewFailed("timed out.", job: try job(#"{"state":"failed","attempts":1,"error":"timed out."}"#), agent: "Claude", now: now),
      "The AI review failed: timed out.")
    XCTAssertEqual(
      Words.reviewFailed(late, job: try job(#"{"state":"queued","attempts":1,"error":"\#(late)","retry_at":"2026-11-15T09:02:20.000Z"}"#), agent: "Claude", now: now),
      "The AI review failed: no answer in 5 minutes, so it was stopped. Claude tries again in 2 minutes.")
    XCTAssertEqual(
      Words.reviewFailed(late, job: try job(#"{"state":"queued","attempts":2,"error":"\#(late)","retry_at":"2026-11-15T09:00:20.000Z"}"#), agent: "Claude", now: now),
      "The AI review failed: no answer in 5 minutes, so it was stopped. Claude tries again in 1 minute.")
    XCTAssertEqual(
      Words.reviewFailed(late, job: try job(#"{"state":"queued","attempts":1,"error":"\#(late)","retry_at":"2026-11-15T08:59:00.000Z"}"#), agent: "Claude", now: now),
      "The AI review failed: no answer in 5 minutes, so it was stopped. Claude tries again shortly.")
    // Paused: the desk's own words, whatever its job says.
    let paused = "AI reviews are paused: Claude Code is logged out"
    XCTAssertEqual(Words.reviewFailed(paused, job: nil, agent: "Claude", now: now), paused)
    XCTAssertEqual(Words.reviewFailed(paused, job: try job(#"{"state":"failed","attempts":3,"error":"timed out"}"#), agent: "Claude", now: now), paused)
  }

  func testConcernsAreListedOnlyWhenTheNotesCannotSitInTheCode() throws {
    XCTAssertFalse(Words.listsConcerns(stale: false, notes: 5))
    XCTAssertTrue(Words.listsConcerns(stale: true, notes: 5), "an earlier commit's notes aren't on this diff")
    XCTAssertTrue(Words.listsConcerns(stale: false, notes: 0))
    XCTAssertEqual(Words.fit["partial"], "Not quite what the description says")
    XCTAssertEqual(Words.fit["differs"], "Not what the description says")
    XCTAssertNil(Words.fit["matches"])
  }
}
