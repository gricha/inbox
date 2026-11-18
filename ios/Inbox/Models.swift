import Foundation

// The desk's JSON, as src/types.ts has it, read leniently: every field a newer or older desk might leave out is optional,
// every enum stays the string it came as (compared against the values known here), and a list drops a row it can't read
// rather than failing the page. Times stay strings too, parsed where they're shown (Format.swift).

// A list that skips the elements it can't decode, and reads as empty when its key is missing.
@propertyWrapper
struct Lossy<T: Decodable & Sendable>: Decodable, Sendable {
  var wrappedValue: [T]

  init() {
    wrappedValue = []
  }

  init(wrappedValue: [T]) {
    self.wrappedValue = wrappedValue
  }

  private struct Skipped: Decodable {}

  init(from decoder: Decoder) throws {
    var list = try decoder.unkeyedContainer()
    var out: [T] = []
    while !list.isAtEnd {
      if let one = try? list.decode(T.self) { out.append(one) } else { _ = try? list.decode(Skipped.self) }
    }
    wrappedValue = out
  }
}

extension KeyedDecodingContainer {
  func decode<T>(_: Lossy<T>.Type, forKey key: Key) throws -> Lossy<T> {
    (try? decodeIfPresent(Lossy<T>.self, forKey: key)) ?? Lossy()
  }
}

enum DeskJSON {
  static func decoder() -> JSONDecoder {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
  }
}

struct Health: Decodable, Sendable {
  var ok: Bool?
  var version: String?
}

// GET /api/setup, of which the phone reads one thing: whether the desk's first run is still unfinished.
struct SetupView: Decodable, Sendable {
  var needed: Bool?
}

struct ErrorBody: Decodable, Sendable {
  var error: String?
  var tag: String?
  var reason: String?
}

// MARK: Overview

struct Overview: Decodable, Sendable {
  var me: String?
  var syncedAt: String?
  var syncing: Bool?
  var syncError: String?
  @Lossy var configErrors: [ConfigError]
  @Lossy var connectors: [Connector]
  var inflight: Total?
  var agent: Bool?
  var aiAgent: String?
  var rateLimit: RateLimit?
  @Lossy var spaces: [Space]  // for a board's name, where an item says which board placed it

  struct Space: Decodable, Sendable {
    var name: String?
    @Lossy var boards: [Board]

    struct Board: Decodable, Sendable {
      var id: String?
      var name: String?
    }
  }

  // App.tsx's boardLabel(): the board's name, with its space's when two boards share one.
  func boardLabel(_ id: String) -> String {
    let all = spaces.flatMap { s in s.boards.map { (board: $0, space: s.name ?? "") } }
    guard let b = all.first(where: { $0.board.id == id }), let name = b.board.name else { return id }
    return all.filter { $0.board.name == name }.count > 1 ? "\(name) (\(b.space))" : name
  }

  struct ConfigError: Decodable, Sendable {
    var path: String?
    var message: String?
  }

  struct Connector: Decodable, Sendable {
    var id: String?
    var status: String?
    var error: String?
  }

  struct Total: Decodable, Sendable {
    var total: Int?
  }

  struct RateLimit: Decodable, Sendable {
    var remaining: Int?
    var resetAt: String?
  }
}

// MARK: The queue

struct QueueView: Decodable, Sendable {
  var inbox: InboxParts?
  @Lossy var inquiries: [Inquiry]
  @Lossy var sessions: [SessionCard]
  var notes: NotesView?
  var sections: Sections?
  @Lossy var hidden: [Card]
  @Lossy var cleared: [Card]
  @Lossy var resolved: [Card]
  var reviewing: Int?
  var paused: Paused?
  var firstPass: FirstPass?
  var stacks: [String: Stack]?

  struct InboxParts: Decodable, Sendable {
    @Lossy var urgent: [Card]
    @Lossy var standard: [Card]
    @Lossy var fyi: [Card]
  }

  struct Sections: Decodable, Sendable {
    @Lossy var blocked: [Card]
  }

  struct Paused: Decodable, Sendable {
    var who: String?
    var why: String?
  }

  struct FirstPass: Decodable, Sendable {
    var line: String?
  }
}

struct Card: Decodable, Identifiable, Sendable {
  let id: String
  let kind: String  // "pr" | "issue"
  let repo: String
  let number: Int
  let title: String
  var url: String?
  var author: String?
  var authorBot: Bool?
  var by: String?
  var attribution: Attribution?  // a bot's PR: who it was opened for, and the bot
  var people: [String]?
  var stage: String?
  var bucket: String?
  var board: String?
  var why: String?
  var handoff: Handoff?
  var demoted: String?
  var ci: String?
  var review: String?
  var draft: Bool?
  var activityAt: String?
  var waitingSince: String?
  var new: Bool?
  var pinned: Bool?
  var status: String?  // "active" | "done" | "snoozed" | "muted"
  var snoozeUntil: String?
  var snoozeWhen: String?
  var wakeOn: [String]?
  var doneAt: String?
  var cta: String?  // "ready" | "reply" | "reviewers" | "handoff"
  var reviewOptional: Bool?
  var actions: [String]?  // the GitHub writes the desk allows on it now (Words.more names them); absent when none
  var resolved: String?
  var resolvedAt: String?
  var inflight: Bool?
  var stack: StackRef?
  var blocker: Blocker?
  var blocks: [String]?  // open PRs that need this one merged first, as repo#number
  var depth: Int?
  var reason: String?
  var quick: String?
  var placedBy: String?  // "hard" | "pin" | "claude" | "automation": whose its place is (Words.placedBy)
  var section: String?  // "urgent" | "standard" | "fyi": where it is on the Inbox; absent off it
  var size: Size?  // a PR's lines added and removed
  var verdict: String?  // the AI review of its current commit: "look" | "skim" | "skip"
  var preflight: Preflight?

  struct Preflight: Decodable, Sendable {
    var state: String?
    var verdict: String?
    var risk: String?  // "low" | "medium" | "high"
  }

  struct Size: Decodable, Sendable {
    var add: Int?
    var del: Int?
  }

  struct Handoff: Decodable, Sendable {
    var why: String?
    var from: String?
  }

  struct StackRef: Decodable, Sendable {
    var id: String?
    var pos: Int?
    var size: Int?
  }

  struct Blocker: Decodable, Sendable {
    var id: String?
    var ref: String?
    var waits: String?
  }

  // docs/api.md → Opened for you: person is "@login", a name, or "" when nothing says.
  struct Attribution: Decodable, Sendable {
    var person: String?
    var agent: String?
    var source: String?  // "line" | "assignee" | "model" | "none"
  }

  var isPR: Bool { kind == "pr" }
  var mine: Bool { by == "you" }
  // Whose picture its row shows: a person's. None for you, nor a bot that wrote its own PR (docs/ui.md: "none for you or a bot"),
  // nor a bot's PR opened for someone known by a name alone.
  var face: String? {
    if mine || (authorBot == true && by == author) { return nil }
    if let person = attribution?.person { return person.hasPrefix("@") ? String(person.dropFirst()) : nil }
    return by
  }
  // Who it's by in words, as the window's byOf(): "dana via sentry-junior", "you via …", the bot alone when nobody's known.
  var byWords: String {
    guard let a = attribution, let agent = a.agent, !agent.isEmpty else { return by ?? author ?? "" }
    if mine { return "you via \(agent)" }
    let person = a.person ?? ""
    if person.isEmpty { return agent }
    return "\(person.hasPrefix("@") ? String(person.dropFirst()) : person) via \(agent)"
  }
  var active: Bool { (status ?? "active") == "active" }
  // Hand off for merge is for a PR through its review (view.ts's handsOff()): not a draft, not one awaiting review, nor
  // one nobody's asked unless its repo needs no review. Offered on your own open PR; the desk refuses the rest in words.
  var handsOff: Bool {
    isPR && draft != true && inflight != true && (cta != "reviewers" || reviewOptional == true) && !["required", "changes_requested"].contains(review ?? "")
  }
  // The one thing its page is there for (Words.act names it): the row's own call to action, else Approve on someone's
  // PR, Comment on an issue, Hand off for merge on yours once it's through review. None in Merging or once it's closed.
  // `open` is GitHub's state alone, as the window's review has it: an open PR the desk resolved ("approved by alice",
  // "no longer requested") can still be approved and commented on.
  func act(open: Bool) -> String? {
    guard open, inflight != true else { return nil }
    if let cta, Words.cta[cta] != nil { return cta }
    if !isPR { return "comment" }
    if !mine { return "approve" }
    return handsOff ? "handoff" : nil
  }

  var shortRef: String { "\(repo.split(separator: "/").last.map(String.init) ?? repo)#\(number)" }
}

struct Stack: Decodable, Sendable {
  var id: String?
  var base: String?
  @Lossy var line: [Member]
  @Lossy var forks: [Member]
  var current: String?

  struct Member: Decodable, Identifiable, Sendable {
    let id: String
    var number: Int?
    var title: String?
    var state: String?  // "open" | "merged" | "closed"
    var ci: String?
    var review: String?
    var current: Bool?
  }

  static let shown = 4

  // What a review's stack list draws, as Review.tsx's StackList: the open PRs bottom first and the one on screen,
  // four of them around it when two or more would go behind "N more" (`more`, 0 for no fold), and the other branches.
  func around(_ id: String, all: Bool) -> (line: [Member], more: Int, forks: [Member]) {
    let live = { (ms: [Member]) in ms.filter { $0.state == "open" || $0.current == true || $0.id == id } }
    let line = live(self.line)
    let more = line.count - Stack.shown
    guard more >= 2 else { return (line, 0, live(forks)) }
    let from = min(max(0, (line.firstIndex { $0.current == true || $0.id == id } ?? 0) - 1), more)
    return (all ? line : Array(line[from..<from + Stack.shown]), more, live(forks))
  }
}

struct Inquiry: Decodable, Identifiable, Sendable {
  let id: String
  var at: String?
  var from: String?
  var question: String?
  var context: String?
  @Lossy var options: [Option]
  @Lossy var links: [Link]
  var itemId: String?
  var answer: Answer?
  var card: Card?  // InquiryView only: the item it's about, if the desk holds it

  struct Option: Decodable, Sendable {
    var answer: String?
    var next: String?
  }

  struct Link: Decodable, Sendable {
    var label: String?
    var url: String?
  }

  struct Answer: Decodable, Sendable {
    var text: String?
    var dismissed: Bool?
    var readAt: String?
    var tracksPickup: Bool  // read_at is there (even null) only when the asker can pick the answer up

    private enum Keys: String, CodingKey { case text, dismissed, readAt }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: Keys.self)
      text = try? c.decodeIfPresent(String.self, forKey: .text)
      dismissed = try? c.decodeIfPresent(Bool.self, forKey: .dismissed)
      readAt = try? c.decodeIfPresent(String.self, forKey: .readAt)
      tracksPickup = c.contains(.readAt)
    }
  }
}

struct SessionCard: Decodable, Identifiable, Sendable {
  let id: String  // "session:<id>"
  var kind: String?
  var name: String?
  var cwd: String?
  var branch: String?
  var reason: String?
  var since: String?
  var excerpt: String?
  var resetsAt: String?
  var alive: Bool?
  var actions: [String]?
  var status: String?
}

struct Note: Decodable, Identifiable, Sendable {
  let id: String
  var at: String?
  var text: String?
  var remindAt: String?
  var section: String?  // "urgent" | "standard" | "fyi" where you put it; none: Standard
}

struct NoteAnswer: Decodable, Sendable {
  var note: Note?
}

// Placed by the desk: due reminders lead Urgent, notes without one lead the section you put them in, the rest wait.
struct NotesView: Decodable, Sendable {
  @Lossy var due: [Note]
  @Lossy var urgent: [Note]
  @Lossy var open: [Note]  // Standard's
  @Lossy var fyi: [Note]
  @Lossy var later: [Note]

  var all: [Note] { due + urgent + open + fyi + later }
}

// MARK: Merging

struct InflightView: Decodable, Sendable {
  @Lossy var rows: [Row]
  var stacks: [String: Stack]?
  var coordinator: Coordinator?
  @Lossy var work: [Work]  // what your agent owes you, as the desk's ledger has it: the group under the live rows

  struct Row: Decodable, Identifiable, Sendable {
    let card: Card
    var state: String?  // "open" | "closed" | "merged"
    var waitsOn: String?
    var note: AgentNote?
    var rebase: Bool?  // being rebased: it stays on the Inbox ("rebasing"), not listed in Merging
    var id: String { card.id }
  }

  struct AgentNote: Decodable, Sendable {
    var text: String?
    var at: String?
  }

  // Merging's own rows, as Inflight.tsx: open and not being rebased. Then what landed.
  var live: [Row] { rows.filter { $0.state == "open" && $0.rebase != true } }
  var landed: [Row] { rows.filter { $0.state != "open" } }

  struct Coordinator: Decodable, Sendable {
    var on: Bool?
    var id: String?
    var url: String?
    var error: String?
    var status: String?  // "busy" | "shell" | "waiting" | "idle" | "stopped"; none before its first turn
    var queued: [String]?  // your asks it hasn't been handed yet
    var activity: [String]?  // its latest steps, oldest first: the session's own words, so text
    var saying: String?  // what it's said so far this turn, whole messages; "" when nothing yet. The session's, so text
  }
}

// One job of Merging's "<agent>'s work": an AI review, an ask of yours, or an answer whoever asked hasn't read.
struct Work: Decodable, Identifiable, Sendable {
  let kind: String  // "ai_review" | "ask" | "answer"
  let key: String  // the PR's id, the ask's, the question's
  var item: String?
  var state: String?  // "queued" | "running" | "done" | "failed"
  var attempts: Int?
  var queuedAt: String?
  var startedAt: String?
  var finishedAt: String?
  var retryAt: String?
  var error: String?
  var title: String?
  var from: String?  // an answer's: the session that asked
  var id: String { "\(kind) \(key)" }

  static let tries = 3  // src/types.ts's JOB_ATTEMPTS
}

// GET /api/asks: your chat with your agent, oldest first, and what it's doing about the one it hasn't answered.
struct AsksView: Decodable, Sendable {
  var on: Bool?  // the coordinator setting: off, nothing is sent
  @Lossy var asks: [Ask]
  var coordinator: InflightView.Coordinator?
  var options: AgentOptions?
  var models: AgentModels?  // what your agent's own command lists (src/models.ts); absent until the desk has read it

  struct AgentModels: Decodable, Sendable {
    @Lossy var models: [AgentKind.Choice]
    @Lossy var efforts: [AgentKind.Choice]
  }

  // How your agent runs, as the chat's own controls set it (Settings → Agent's settings).
  struct AgentOptions: Decodable, Sendable {
    var agent: String?  // "claude-code" | "codex" | "opencode"
    var bypass: Bool?  // agent.coordinator_bypass
    var model: String?  // agent.coordinator_model; "" is the agent's own default
    var effort: String?  // agent.coordinator_effort; "" is its own default
  }
}

#if DEBUG
  extension AsksView {
    // The chat as the mock never sends it, for shots and for trying a state by hand (-asks): no asks, your agent off,
    // and each thing your agent can be doing about the last ask.
    func debugging(_ state: String) -> AsksView {
      var v = self
      switch state {
      case "empty": v.asks = []
      case "off":
        v.on = false
        v.asks = []
      case "on": v.on = true  // though the desk says off: a send is then refused, in its words
      case "waiting": v.coordinator?.status = "waiting"
      case "queued": v.coordinator?.queued = asks.last.map { [$0.id] }
      case "onit": v.coordinator?.activity = []
      case "stopped": v.coordinator?.status = "stopped"
      case "error": v.coordinator?.error = "claude isn't logged in: run `claude` once in a terminal"
      case "none": v.coordinator = nil
      default: break
      }
      return v
    }
  }
#endif

// A setting's value as PUT /api/settings takes it: a switch or words.
enum SettingValue: Encodable, Sendable, Equatable {
  case flag(Bool)
  case text(String)

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .flag(let b): try c.encode(b)
    case .text(let t): try c.encode(t)
    }
  }
}

// PUT /api/settings' answer: ok false with the settings' own errors when it didn't take.
struct SettingsAnswer: Decodable, Sendable {
  var ok: Bool?
  @Lossy var errors: [Overview.ConfigError]
}

// POST /api/ask's answer.
struct AskAnswer: Decodable, Sendable {
  var ask: Ask?
}

// MARK: An item, opened

struct ItemDetail: Decodable, Sendable {
  let card: Card
  var item: Item?
  var ai: AiReview?
  var aiStale: Bool?
  var generating: Bool?
  @Lossy var activity: [ActivityEvent]
  var stack: Stack?
  var signals: Signals?
  // An issue's: its pre-review (the latest, even if the issue has moved on since), its run, and whether its author is
  // on the desk's blocklist.
  var issueAi: IssueReview?
  var issueAiState: String?  // "running" | "failed" | "off"
  var issueAiError: String?
  var blockedAuthor: Bool?
  @Lossy var placements: [Placement]  // where each board put it; its rule trace is never read

  struct Placement: Decodable, Sendable {
    var board: String?
    var bucket: String?
    var ruleBucket: String?  // before caps
    var why: String?
    var demoted: String?  // why it moved down: "3 from PRs to review are urgent already"
    var judge: Judge?

    struct Judge: Decodable, Sendable {
      var bucket: String?
      var why: String?
      var by: String?  // an automation's name
    }
  }

  // Written before the issue's latest activity.
  var preStale: Bool { issueAi != nil && issueAi?.updatedAt != item?.updatedAt }

  // Make PR with fix is offered: a fix your agent can make, on an open issue nobody flagged or blocked (Detail.tsx's fixable).
  var fixable: Bool { issueAi?.fixable == true && issueAi?.injection == nil && item?.state == "open" && blockedAuthor != true }

  // Where the pre-review stands, said above it or in its place (IssuePre's status in Detail.tsx); nil: only the review, or
  // nothing at all when AI reviews are off.
  enum PreStanding: Equatable {
    case running(again: Bool)
    case failed(String)
    case stale
    case none
  }

  var preStanding: PreStanding? {
    switch issueAiState {
    case "running": .running(again: issueAi != nil)
    case "failed": .failed(issueAiError ?? "")
    case "off": nil
    default: preStale ? .stale : issueAi == nil ? PreStanding.none : nil
    }
  }

  struct Signals: Decodable, Sendable {
    var me: Me?

    // How you were asked (Words.asked).
    struct Me: Decodable, Sendable {
      var author: Bool?
      var assignee: Bool?
      var requested: Bool?
      var requestedDirect: Bool?
      var requestedTeam: String?
      var requestedCodeowner: Bool?
      var requestedBy: String?
      var requestedByBot: Bool?
      var requestedHours: Double?
    }
  }

  struct Item: Decodable, Sendable {
    var author: String?
    var updatedAt: String?
    var state: String?  // "open" | "closed" | "merged"
    var draft: Bool?
    var headOid: String?  // the commit this was read at: what Approve, Merge and Request changes are pinned to
    var body: String?  // its description: untrusted GitHub text
    var labels: [String]?
    var additions: Int?
    var deletions: Int?
    var changedFiles: Int?
    var commentsTotal: Int?
    @Lossy var reviewRequests: [Request]
    @Lossy var reviews: [Review]  // most recent last

    struct Request: Decodable, Sendable {
      var reviewer: String?
      var type: String?  // "user" | "team"
    }

    struct Review: Decodable, Sendable {
      var author: String?
      var state: String?
      var commit: String?
    }
  }
}

// An issue's pre-review: what's wrong and what we'd do, a walk through it when it isn't simple, or the screen's flag with
// nothing else read. Every word of it is the model's.
struct IssueReview: Decodable, Sendable {
  var updatedAt: String?  // the issue's updated_at when it was read
  var at: String?
  var model: String?
  var injection: Injection?
  var kind: String?  // "bug" | "feature" | "question" | "other"
  var summary: String?
  var problem: String?
  var cause: String?
  @Lossy var evidence: [Evidence]
  var fix: String?
  var fixable: Bool?
  @Lossy var steps: [Step]
  var code: Bool?  // read from the code in your clone, not the issue's text alone

  struct Injection: Decodable, Sendable {
    var who: String?
    var why: String?
  }

  struct Evidence: Decodable, Sendable {
    var path: String?
    var line: Int?
    var why: String?
  }

  struct Step: Decodable, Sendable {
    var title: String?
    var body: String?
  }
}

struct AiReview: Decodable, Sendable {
  var verdict: String?  // "look" | "skim" | "skip"
  var risk: String?  // "low" | "medium" | "high"
  var summary: String?
  var since: String?
  var concerns: [String]?
  @Lossy var riskReasons: [RiskReason]
  @Lossy var notes: [Note]  // what order's hunks and steps index into
  var intent: Intent?
  @Lossy var look: [Look]
  @Lossy var interfaces: [Interface]
  @Lossy var improvements: [Note]
  @Lossy var diagrams: [Diagram]
  var guide: Guide?
  var headOid: String?  // the commit it read
  var model: String?
  var at: String?
  var doc: String?  // its review document's id

  struct RiskReason: Decodable, Sendable {
    var factor: String?
    var why: String?
  }

  // A note on a line of the diff; line 0 is about the whole file.
  struct Note: Decodable, Sendable {
    var path: String?
    var line: Int?
    var side: String?  // "new" | "old"
    var body: String?
  }

  struct Intent: Decodable, Sendable {
    var goal: String?
    var fit: String?  // "matches" | "partial" | "differs" | "undescribed"
    var gap: String?
    var stack: String?
  }

  // Where correctness hinges.
  struct Look: Decodable, Sendable {
    var path: String?
    var side: String?
    var line: Int?
    var end: Int?
    var why: String?
  }

  struct Interface: Decodable, Sendable {
    var name: String?
    var kind: String?
    var change: String?  // "added" | "changed" | "removed"
    var breaking: Bool?
    var impact: String?
    var path: String?
    var side: String?
    var line: Int?
  }

  struct Diagram: Decodable, Identifiable, Sendable {
    let id: String
    var title: String?
    var caption: String?
    var source: String?  // the Mermaid it was parsed from
    var graph: DiagramGraph?
  }

  struct Guide: Decodable, Sendable {
    @Lossy var steps: [Step]

    struct Step: Decodable, Sendable {
      var title: String?
      var body: String?
      var check: String?
      var note: String?
      var diagram: String?
      @Lossy var hunks: [Ref]
    }

    struct Ref: Decodable, Sendable {
      var id: String?
      var path: String?
    }
  }
}

// A diagram as plain data (src/types.ts's DiagramGraph): a flowchart or a sequence. Every string is the model's.
enum DiagramGraph: Decodable, Sendable {
  case flow(Flow)
  case sequence(Seq)
  case other(String)  // a kind this app doesn't know

  struct Flow: Decodable, Sendable {
    var direction: String?  // "LR" | "TB"
    @Lossy var nodes: [Node]
    @Lossy var edges: [Edge]
    @Lossy var groups: [Group]
  }

  struct Node: Decodable, Identifiable, Sendable {
    let id: String
    var label: String?
    var shape: String?  // "box" | "term" | "store" | "choice" | "circle"
    var mark: String?  // "new" | "changed" | "removed"
    var group: String?
  }

  struct Edge: Decodable, Sendable {
    var from: String?
    var to: String?
    var label: String?
    var style: String?  // "arrow" | "line" | "dotted"
  }

  struct Group: Decodable, Identifiable, Sendable {
    let id: String
    var label: String?
  }

  struct Seq: Decodable, Sendable {
    @Lossy var participants: [Participant]
    @Lossy var messages: [Message]
    @Lossy var notes: [Note]
  }

  struct Participant: Decodable, Identifiable, Sendable {
    let id: String
    var label: String?
    var actor: Bool?
  }

  struct Message: Decodable, Sendable {
    var from: String?
    var to: String?
    var text: String?
    var reply: Bool?
  }

  struct Note: Decodable, Sendable {
    var over: [String]?
    var text: String?
    var at: Int?  // drawn before messages[at]
  }

  private enum Keys: String, CodingKey { case kind }

  init(from decoder: Decoder) throws {
    let kind = (try? decoder.container(keyedBy: Keys.self).decodeIfPresent(String.self, forKey: .kind)) ?? ""
    switch kind {
    case "flow": self = .flow(try Flow(from: decoder))
    case "sequence": self = .sequence(try Seq(from: decoder))
    default: self = .other(kind)
    }
  }
}

struct ActivityEvent: Decodable, Identifiable, Sendable {
  var seq: Int?
  var at: String?
  var kind: String?
  var actor: String?
  var data: [String: Loose]?
  var id: String { "\(seq ?? 0) \(at ?? "") \(kind ?? "")" }
}

// A value in an event's data: a string or a flag today, read as words either way.
enum Loose: Decodable, Sendable, Equatable {
  case string(String), bool(Bool), number(Double), null

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let s = try? c.decode(String.self) { self = .string(s) }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else { self = .null }
  }

  var text: String {
    switch self {
    case .string(let s): s
    case .bool(let b): String(b)
    case .number(let n): n == n.rounded() ? String(Int(n)) : String(n)
    case .null: ""
    }
  }

  var truthy: Bool { !text.isEmpty && self != .bool(false) }
}

// MARK: A PR's conversation, and who to ask

// GET /api/review/:id: one PR's review, whole (src/types.ts's ReviewView). The page draws from it alone; an older desk
// may lack any part of it. Its hunks ride in `order`; `files` is the list without their patches.
struct ReviewView: Decodable, Sendable {
  var card: Card?
  var item: ItemDetail.Item?
  @Lossy var files: [ReviewFile]
  var diffHead: String?  // the commit the diff's files are at; can be newer than item.headOid until the next sync
  var filesError: String?  // the diff couldn't be fetched
  var order: ReviewOrder?
  var ai: AiReview?  // the latest, even if stale
  var aiStale: Bool?
  var aiError: String?  // the last failed attempt on this commit, or why AI reviews are paused
  var generating: Bool?
  var aiJob: Job?
  var approve: Allowance?
  @Lossy var activity: [ActivityEvent]
  var stack: Stack?
  @Lossy var asks: [Ask]  // yours to your agent about it, oldest first
  var checks: Checks?  // nil: none ran, or they couldn't be fetched
  var checksError: String?
  var reviewers: Standings?
  var merge: String?  // what stands in its merge's way, in one line
  @Lossy var conversation: [Conversation]  // those waiting on you first
  var conversationError: String?  // it couldn't be fetched
  var reading: Bool?  // your agent is reading the ones waiting on you
  var readingError: String?
  @Lossy var viewed: [String]  // the marks of hunks (or of files without one) you marked viewed

  struct Allowance: Decodable, Sendable {
    var ok: Bool?
    var reason: String?  // why not: "it's your PR", "you approved this commit"
    var approved: Bool?  // you approved its head
  }

  // Why Approve is off, as the window says it; nil when the desk allows it.
  var cantApprove: String? {
    approve?.ok == true ? nil : Words.sentence("Can't approve: \(approve?.reason ?? "not allowed")")
  }
}

// One changed file. Its patch is never read: the same lines are in ReviewOrder's hunks.
struct ReviewFile: Decodable, Sendable {
  var path: String?
  var previousPath: String?  // renames
  var status: String?  // "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
  var additions: Int?
  var deletions: Int?

  private enum CodingKeys: String, CodingKey { case path, previousPath, status, additions, deletions }
}

// Every hunk once, in the order to read them, as the desk decided it.
struct ReviewOrder: Decodable, Sendable {
  var ranked: Bool?  // false: no ranking for this commit, `chunks` is every hunk file by file
  @Lossy var chunks: [ReviewHunk]
  @Lossy var unread: [ReviewHunk]  // your agent didn't see these
  @Lossy var skipped: [ReviewHunk]  // it saw these and left them out
  @Lossy var rest: [Rest]  // folded, by file: lockfiles, generated files, files with no text diff
  var notes: [Int]?  // ai.notes in reading order
  var steps: [Step]?  // the walk-through, when this commit's review has one
  var beyond: [ReviewHunk]?  // with steps: the hunks no step covers

  struct Rest: Decodable, Sendable {
    var path: String?
    var file: Int?
    var why: String?
    @Lossy var hunks: [ReviewHunk]
    var notes: [Int]?
    var mark: String?  // the file's own, for one with no hunks to carry them
  }

  struct Step: Decodable, Sendable {
    var title: String?
    var body: String?
    var check: String?  // what to verify here, or ""
    var note: String?
    var diagram: String?  // its diagram's id in ai.diagrams
    @Lossy var hunks: [ReviewHunk]
  }
}

struct ReviewHunk: Decodable, Identifiable, Sendable {
  let id: String  // h1, h2, … across the files in order
  var path: String?
  var file: Int?  // index in ReviewView.files
  var header: String?  // its @@ line
  var patch: String?  // its own lines, the @@ line first
  var mark: String?  // what it changes: the same after a rebase that only moves it, new once a push rewrites its lines
  var additions: Int?
  var deletions: Int?
  var level: String?  // "look" | "skim" | "skip" | "unread"; nil: no ranking for this commit
  var rank: Int?
  var why: String?
  var notes: [Int]?  // indices into ai.notes
  var looks: [Int]?  // indices into ai.look that start on it
}

// The AI review's job: running, or for this commit.
struct Job: Decodable, Sendable {
  var state: String?  // "queued" | "running" | "done" | "failed"
  var attempts: Int?
  var startedAt: String?
  var retryAt: String?
  var error: String?
  var head: String?
}

// Something you asked your agent about the PR, and its answer (untrusted: an agent wrote it).
struct Ask: Decodable, Identifiable, Sendable {
  let id: String
  var at: String?
  var text: String?
  var itemId: String?
  var threadId: String?
  var threadUrl: String?
  var lines: Lines?
  var fix: Bool?
  var answer: Answer?

  struct Lines: Decodable, Sendable {
    var path: String?
    var line: Int?
    var side: String?
    var start: Start?  // a range's first line; the phone sends single lines, the window may have sent a range
    var head: String?
    var note: Bool?

    struct Start: Decodable, Sendable {
      var line: Int?
      var side: String?
    }
  }

  struct Answer: Decodable, Sendable {
    var text: String?
    var at: String?
  }
}

// A PR's checks on its head commit. A check's name is untrusted GitHub text.
struct Checks: Decodable, Sendable {
  var line: String?  // "CI passing · 14 checks", "2 failing of 14 checks"
  var failing: Bool?  // a check that counts is failing: the line is red
  @Lossy var list: [Check]  // failing first

  struct Check: Decodable, Sendable, Equatable {
    var name: String?
    var state: String?  // "failing" | "cancelled" | "running" | "passing" | "skipped"
    var optional: Bool?  // failing, it doesn't hold the merge back
    var url: String?
  }
}

// Who reviews a PR and where each stands: you are "you", a team is @slug.
struct Standings: Decodable, Sendable {
  var line: String?  // "Approved by marco · waiting on sam", "Nobody's asked"
  var changes: Bool?  // someone asks for changes: the line is amber
  @Lossy var list: [Standing]

  struct Standing: Decodable, Sendable {
    var who: String?
    // Whose picture goes before the name: a person's, not yours and not a team's ("@ml-team").
    var face: String? { who.flatMap { $0 == "you" || $0.hasPrefix("@") || $0.isEmpty ? nil : $0 } }
    var state: String?  // "changes requested" | "asked" | "approved" | "commented"
    var again: Bool?  // asked again while their verdict holds
  }
}

struct Conversation: Decodable, Identifiable, Sendable {
  let id: String  // what a reply goes to
  var kind: String?  // "thread" | "comment" | "review"
  var path: String?  // a thread's file; nil: on the PR
  var line: Int?
  var side: String?  // a thread's: "old" on a removed line
  var outdated: Bool?
  var resolved: Bool?
  var state: String?  // a review's: "approved" | "changes_requested" | "commented"
  @Lossy var comments: [Comment]  // oldest first
  var waitingOnYou: Bool?
  var url: String?
  var take: Take?

  struct Comment: Decodable, Identifiable, Sendable {
    let id: String
    var author: String?
    var bot: Bool?
    var body: String?
    var at: String?
    var url: String?
  }

  // Your agent's read of one waiting on you. Untrusted: it read GitHub text.
  struct Take: Decodable, Sendable {
    var gist: String?
    var take: String?
    var commentId: String?  // the latest comment it read
    var at: String?
  }
}

struct Reviewer: Decodable, Identifiable, Sendable, Equatable {
  let id: String  // a node id: what Ready for review and Ask reviewers send
  var login: String
  var name: String?
  var team: Bool?
  var suggested: Bool?  // GitHub's own pick for this PR
}

// MARK: What the desk answers to a write

struct PairAnswer: Decodable, Sendable {
  var token: String?
  var device: Device?

  struct Device: Decodable, Sendable {
    var id: String?
    var name: String?
  }
}

struct ActAnswer: Decodable, Sendable {
  var undoSeq: Int?
}

struct UndoAnswer: Decodable, Sendable {
  var id: String?
  var action: String?
}

struct Ok: Decodable, Sendable {
  var ok: Bool?
}

struct BlockAnswer: Decodable, Sendable {
  var author: String?
}

struct Wrote: Decodable, Sendable {
  var url: String?  // what was written, on GitHub; empty for a write with nothing to link
}

struct ReadyAnswer: Decodable, Sendable {
  var done: Bool?  // false: ready, but nobody's asked to review it, so it stays on the desk
}

struct AnswerAnswer: Decodable, Sendable {
  var inquiry: Inquiry?
}

struct KickAnswer: Decodable, Sendable {
  var note: String?
}
