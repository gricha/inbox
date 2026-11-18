import XCTest

@testable import Inbox

// The diff's pure parts against the mock's own hunks (Fixtures/review-steps.json): a patch's lines and their numbers,
// Code changes order, the threads on their lines, and how much of a long file is drawn.
@MainActor
final class PatchLinesTests: XCTestCase {
  private func review() throws -> ReviewView { try Fixture.decode("review-steps") }

  private func hunk(_ id: String) throws -> ReviewHunk {
    let o = try XCTUnwrap(try review().order)
    return try XCTUnwrap((o.chunks + o.unread + o.skipped).first { $0.id == id }, "no \(id) in the fixture")
  }

  private func order(_ json: String) throws -> ReviewOrder {
    try DeskJSON.decoder().decode(ReviewOrder.self, from: Data(json.utf8))
  }

  func testAHunksLinesAndTheirNumbers() throws {
    // @@ -1,8 +1,9 @@: two unchanged, one removed, one added in its place, …, one added near the end.
    let patch = try XCTUnwrap(try hunk("h2").patch)
    let lines = patchLines(patch)
    XCTAssertEqual(lines.count, 11)
    XCTAssertEqual(lines.count, Diff.rows(patch), "counted without parsing")
    XCTAssertEqual(lines[0], PatchLine(kind: .hunk, old: 1, new: 1, text: "@@ -1,8 +1,9 @@"))
    XCTAssertEqual(lines[1], PatchLine(kind: .context, old: 1, new: 1, text: #"import type { Query, Row } from "./types.ts";"#))
    XCTAssertEqual(lines[3], PatchLine(kind: .del, old: 3, new: nil, text: #"import { scan } from "./scan.ts";"#))
    XCTAssertEqual(lines[4], PatchLine(kind: .add, old: nil, new: 3, text: #"import { DEFAULT_BATCH, DEFAULT_BUDGET_MS, streamRows } from "./stream.ts";"#))
    XCTAssertEqual(lines[5], PatchLine(kind: .context, old: 4, new: 4, text: ""), "an empty line of the file")
    XCTAssertEqual(lines[9], PatchLine(kind: .add, old: nil, new: 8, text: "  partial: boolean;"))
    XCTAssertEqual(lines[10], PatchLine(kind: .context, old: 8, new: 9, text: "}"))

    // @@ -14,10 +15,14 @@: the two sides run apart.
    let later = patchLines(try XCTUnwrap(try hunk("h3").patch))
    XCTAssertEqual(later[0].text, "@@ -14,10 +15,14 @@ export function explain(q: Query): string {", "its @@ line whole")
    XCTAssertEqual([later[1].old, later[1].new], [14, 15])
    XCTAssertEqual(later.first { $0.kind == .del }, PatchLine(kind: .del, old: 17, new: nil, text: "export async function runPlan(q: Query): Promise<PlanResult> {"))
    XCTAssertEqual(later.last, PatchLine(kind: .context, old: 23, new: 28, text: "export function estimate(q: Query): number {"))
  }

  // Viewed, as Review.tsx's isShut() and markViewed(): a file all of whose marks are viewed opens folded, a press opens
  // it for now, ticking folds it and unticking opens it, even one that starts folded.
  func testViewedFolding() throws {
    let (list, _) = Diff.traditional(try XCTUnwrap(try review().order))
    let plan = try XCTUnwrap(list.first { $0.path == "src/planner/plan.ts" })
    XCTAssertEqual(plan.marks, ["190d3b30a187d22e", "ac218f9f505c6d80"], "each hunk's, in diff order")
    XCTAssertFalse(Folds.viewed(plan, ["190d3b30a187d22e"]), "a push that rewrote one hunk unticks the file")
    let marks = Folds.marks(["190d3b30a187d22e"], ["ac218f9f505c6d80": true])
    XCTAssertTrue(Folds.viewed(plan, marks), "with a tick on its way")
    XCTAssertFalse(Folds.viewed(plan, Folds.marks(["190d3b30a187d22e", "ac218f9f505c6d80"], ["ac218f9f505c6d80": false])))

    var f = Folds()
    XCTAssertTrue(f.shut(plan, starts: false, viewed: true), "viewed opens folded")
    f.press(plan, viewed: true)
    XCTAssertFalse(f.shut(plan, starts: false, viewed: true), "opened for now")
    f.marked(plan, on: true, starts: false)
    XCTAssertTrue(f.shut(plan, starts: false, viewed: true), "ticked again, it folds")
    f.marked(plan, on: false, starts: true)
    XCTAssertFalse(f.shut(plan, starts: true, viewed: false), "unticked opens even a file that starts folded")
    f.press(plan, viewed: false)
    XCTAssertTrue(f.shut(plan, starts: true, viewed: false))

    let rest = Diff.restOf(try order(#"{"ranked": true, "rest": [{"path": "yarn.lock", "file": 3, "mark": "f00d", "hunks": []}]}"#))
    XCTAssertEqual(rest.first?.marks, ["f00d"], "a file with no text diff marks its own")
    XCTAssertFalse(Folds.viewed(DiffSection(key: "k", path: "p", file: 0, hunks: [], rows: 0), []), "nothing to mark is never viewed")
  }

  func testSeveralHunksTheNoNewlineMarkerAndNothing() {
    let patch = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10 +10,2 @@ fn\n x\n+y\n\\ No newline at end of file"
    let lines = patchLines(patch)
    XCTAssertEqual(lines.map(\.kind), [.hunk, .context, .del, .add, .hunk, .context, .add], "the marker is no line of either file")
    XCTAssertEqual(lines[5], PatchLine(kind: .context, old: 10, new: 10, text: "x"), "numbered from its own @@")
    XCTAssertEqual(lines[6], PatchLine(kind: .add, old: nil, new: 11, text: "y"))
    XCTAssertEqual(Diff.rows(patch), 7)
    XCTAssertEqual(patchLines(""), [])
    XCTAssertEqual(Diff.rows(""), 0)
    XCTAssertNil(Diff.header("@@ not a header"))
    XCTAssertEqual(Diff.header("@@ -10 +10,2 @@ fn").map { [$0.old, $0.oldCount, $0.new, $0.newCount] }, [10, 1, 10, 2], "a count left out is 1")
  }

  func testCodeChangesOrderIsEachFileOnceInThePRsOrder() throws {
    let r = try review()
    let (list, rest) = Diff.traditional(try XCTUnwrap(r.order))
    XCTAssertEqual(rest, list.count, "nothing folded in this one")
    XCTAssertEqual(list.map(\.path), r.files.compactMap(\.path), "the PR's order, whatever the ranking")
    XCTAssertEqual(list.map(\.key), ["file:0", "file:1", "file:2", "file:3", "file:4"])
    XCTAssertEqual(list[1].hunks.map(\.id), ["h2", "h3"], "a skipped hunk and a ranked one, in diff order")
    XCTAssertTrue(list.allSatisfy { $0.level == nil && $0.why == nil }, "no levels")
    XCTAssertEqual([list[1].additions, list[1].deletions, list[1].rows], [9, 4, 11 + 18])
  }

  func testTheFoldIsTheDesksRestEachWithItsWhy() throws {
    let json = { (ranked: Bool) in
      """
      {"ranked":\(ranked),"chunks":[{"id":"h2","path":"b.ts","file":2,"header":"@@ -1 +1 @@","patch":"@@ -1 +1 @@\\n-a\\n+b"}],
       "unread":[{"id":"h10","path":"b.ts","file":2,"header":"@@ -9 +9 @@","patch":"@@ -9 +9 @@\\n-a\\n+b"}],
       "skipped":[{"id":"h1","path":"a.ts","file":0,"header":"@@ -1 +1 @@","patch":"@@ -1 +1 @@\\n-a\\n+b"}],
       "rest":[{"path":"package-lock.json","file":1,"why":"lockfile","hunks":[{"id":"h3","path":"package-lock.json","file":1,"header":"@@ -1 +1 @@","patch":"@@ -1 +1 @@\\n-a\\n+b"}],"notes":[]},
               {"path":"logo.png","file":3,"why":"no text diff: binary or too large","hunks":[],"notes":[]}],"notes":[]}
      """
    }
    let (list, rest) = Diff.traditional(try order(json(true)))
    XCTAssertEqual(rest, 2)
    XCTAssertEqual(list.map(\.path), ["a.ts", "b.ts", "package-lock.json", "logo.png"])
    XCTAssertEqual(list[1].hunks.map(\.id), ["h2", "h10"], "by number, not by name")
    XCTAssertEqual(list[2...].map(\.key), ["rest:package-lock.json", "rest:logo.png"])
    XCTAssertEqual(list[2...].map(\.level), ["skip", "skip"])
    XCTAssertEqual(list[2...].map(\.why), ["lockfile", "no text diff: binary or too large"])
    XCTAssertTrue(list[3].hunks.isEmpty)
    XCTAssertEqual(list[3].rows, 0)
    let model = DiffModel(try order(json(true)))
    XCTAssertEqual(model.list.map(model.startsShut), [false, false, true, true], "what the desk folded starts folded")
    XCTAssertEqual(Diff.traditional(try order(json(false))).list[2...].map(\.level), [nil, nil], "no ranking, no levels")
  }

  func testThreadsOnTheirLines() throws {
    let r = try review()
    let plan = try XCTUnwrap(Diff.traditional(try XCTUnwrap(r.order)).list.first { $0.path == "src/planner/plan.ts" })
    let thread = try XCTUnwrap(r.conversation.first { $0.id == "PRRT_partial" })
    XCTAssertEqual(Diff.threadsOn(r.conversation, path: plan.path, hunks: plan.hunks).map(\.id), ["PRRT_partial"])
    XCTAssertTrue(Diff.threadsOn(r.conversation, path: "src/routes/query.ts", hunks: plan.hunks).isEmpty, "another file's")

    var outdated = thread
    outdated.outdated = true
    var resolved = thread
    resolved.resolved = true
    var away = thread
    away.line = 400
    var comment = thread
    comment.kind = "comment"
    var removed = thread
    removed.side = "old"
    removed.line = 17
    var unplaced = thread
    unplaced.line = nil
    let all = [outdated, resolved, away, comment, removed, unplaced]
    let on = Diff.threadsOn(all, path: plan.path, hunks: plan.hunks)
    XCTAssertEqual(on.map(\.resolved), [true, false], "resolved and on a removed line stay; outdated, off the hunks and not a thread go")
    XCTAssertEqual(on.map(\.side), ["new", "old"])

    // Where each is drawn: under the line with its number on its side.
    let lines = Diff.lines(plan)
    let at = try XCTUnwrap(Diff.index(lines, line: 23, side: "new"))
    XCTAssertEqual(lines[at].text, "    if (Date.now() > deadline) return { rows, cost: costOf(q), partial: true };")
    let was = try XCTUnwrap(Diff.index(lines, line: 17, side: "old"))
    XCTAssertEqual(lines[was].kind, .del)
    XCTAssertNil(Diff.index(lines, line: 400, side: "new"))
    XCTAssertTrue(Diff.onLines(plan.hunks, line: 28, side: "new"))
    XCTAssertFalse(Diff.onLines(plan.hunks, line: 29, side: "new"), "one past the hunk's last")
    XCTAssertFalse(Diff.onLines(plan.hunks, line: 10, side: "new"), "between its two hunks")
  }

  func testWhereACommentOnALineGoes() {
    let path = "src/planner/plan.ts"
    XCTAssertEqual(Diff.spot(path, PatchLine(kind: .add, old: nil, new: 23, text: "x")), LineSpot(path: path, line: 23, side: "new", text: "x"))
    XCTAssertEqual(Diff.spot(path, PatchLine(kind: .del, old: 17, new: nil, text: "x")), LineSpot(path: path, line: 17, side: "old", text: "x"), "numbered in the old file")
    XCTAssertEqual(Diff.spot(path, PatchLine(kind: .context, old: 14, new: 15, text: "x"))?.side, "new")
    XCTAssertEqual(Diff.spot(path, PatchLine(kind: .context, old: 14, new: 15, text: "x"))?.line, 15)
    XCTAssertNil(Diff.spot(path, PatchLine(kind: .hunk, old: 1, new: 1, text: "@@ -1 +1 @@")))
    XCTAssertEqual(LineSpot(path: path, line: 23, side: "new").name, "plan.ts:23")
    XCTAssertEqual(LineSpot(path: "README.md", line: 2, side: "old").name, "README.md:2")
    XCTAssertEqual(LineSpot(path: path, line: 23, side: "new").key, "src/planner/plan.ts:new:23")
  }

  func testALongFileDrawsItsFirstLinesAndCountsTheRest() throws {
    XCTAssertEqual([Diff.capped(0).shown, Diff.capped(0).more], [0, 0])
    XCTAssertEqual([Diff.capped(400).shown, Diff.capped(400).more], [400, 0])
    XCTAssertEqual([Diff.capped(401).shown, Diff.capped(401).more], [400, 1])
    XCTAssertEqual([Diff.capped(1234).shown, Diff.capped(1234).more], [400, 834])

    let long = "@@ -0,0 +1,499 @@\\n" + (1...499).map { "+line \($0)" }.joined(separator: "\\n")
    let short = #"{"id":"h2","path":"b.ts","file":1,"header":"@@ -1 +1 @@","patch":"@@ -1 +1 @@\n-a\n+b"}"#
    let model = DiffModel(try order(#"{"ranked":false,"chunks":[{"id":"h1","path":"a.ts","file":0,"header":"@@ -0,0 +1,499 @@","patch":"\#(long)"},\#(short)]}"#))
    XCTAssertEqual(model.list[0].rows, 500)
    XCTAssertEqual(model.rows(model.list[0]).count, 400)
    XCTAssertEqual(model.rows(model.list[0]).last?.line.new, 399)
    XCTAssertEqual(model.rows(model.list[0]).last?.id, "file:0:399")
    XCTAssertEqual(Diff.capped(model.list[0].rows).more, 100)
    XCTAssertEqual(model.total, 503)
    XCTAssertFalse(model.startsShut(model.list[1]), "open while the whole diff is short enough to draw")

    // Past about 3,000 lines in all, every file starts folded.
    let many = (0..<7).map { #"{"id":"h\#($0 + 1)","path":"f\#($0).ts","file":\#($0),"header":"@@ -0,0 +1,499 @@","patch":"\#(long)"}"# }
    let heavy = DiffModel(try order(#"{"ranked":false,"chunks":[\#(many.joined(separator: ","))]}"#))
    XCTAssertEqual(heavy.total, 3500)
    XCTAssertTrue(heavy.list.allSatisfy(heavy.startsShut))
  }

  func testYoursShowUntilTheConversationHasThem() throws {
    let r = try review()
    let at = LineSpot(path: "src/planner/plan.ts", line: 23, side: "new")
    let mine = [SentWords(spot: at, body: "Agreed."), SentWords(thread: "PRRT_partial", body: "+1, a count is cheap: `streamRows` knows how far it got.")]
    XCTAssertEqual(Diff.pending(mine, in: r.conversation, me: "greg").map(\.body), mine.map(\.body), "someone else's same words aren't yours")
    XCTAssertEqual(Diff.pending(mine, in: r.conversation, me: "Dana").map(\.body), ["Agreed."], "read again with it: no longer shown twice")
  }

  func testAPathsFolderAndName() {
    XCTAssertEqual(Diff.splitPath("src/planner/plan.ts").dir, "src/planner/")
    XCTAssertEqual(Diff.splitPath("src/planner/plan.ts").name, "plan.ts")
    XCTAssertEqual(Diff.splitPath("README.md").dir, "")
  }
}
