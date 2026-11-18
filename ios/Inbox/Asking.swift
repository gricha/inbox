import Foundation

// Ask your agent's words, as web/src/components/Chat.tsx writes them, and Merging's "<agent>'s work" (Inflight.tsx's
// WorkRow). Pure: what an ask is about, its meta line, what your agent is doing about one it hasn't answered, and a
// job's phrase. Keep these in step with those files.

// What the chat was opened about: an item (and a spot in its review), or nothing. What Send carries.
struct ChatAbout: Hashable, Sendable {
  var item: String?
  var thread: Thread?
  var lines: Lines?

  struct Thread: Hashable, Sendable {
    var id: String
    var url: String
    var label: String  // "dana's thread on src/auth.ts:42"
  }

  // One line of the diff at the commit it was read at: Desk.ask()'s `lines` (path, line, side, head).
  struct Lines: Hashable, Sendable {
    var path: String
    var line: Int
    var side: String  // "new" | "old"
    var head: String  // 40 hex: ReviewView.diffHead
  }

  // Where in the review it is: "On <spot>" above the box.
  var spot: String? { thread?.label ?? lines.map { Asking.linesLabel(path: $0.path, line: $0.line, side: $0.side) } }

  // One step wider, as the window's x: from a spot to its PR, from an item to nothing in particular.
  var wider: ChatAbout { thread != nil || lines != nil ? ChatAbout(item: item) : ChatAbout() }

  // Conversation.tsx's threadOf().
  static func thread(_ item: String, _ c: Conversation) -> ChatAbout {
    let whose = "\(c.comments.first?.author ?? "their")'s \(c.kind ?? "thread")"
    let place = (c.path ?? "").isEmpty ? "" : " on \(Words.place(c))"
    return ChatAbout(item: item, thread: Thread(id: c.id, url: c.url ?? "", label: whose + place))
  }
}

// What your agent is doing about an ask it hasn't answered, in the window's order (Chat.tsx's Waiting).
enum Wait: Equatable, Sendable {
  case answer  // nothing known of it yet
  case cantRun(String)
  case permission
  case queued
  case step(String)  // its latest step, in its own words
  case onIt
  case stopped

  // Its step line says only a tool it's using: a step already in what it's said so far (`saying`) reads as On it.
  init(ask: String, live: InflightView.Coordinator?) {
    guard let live else {
      self = .answer
      return
    }
    let working = live.status == "busy" || live.status == "shell"
    if let error = live.error, !error.isEmpty {
      self = .cantRun(error)
    } else if live.status == "waiting" {
      self = .permission
    } else if live.queued?.contains(ask) == true {
      self = .queued
    } else if working, let now = live.activity?.last, !now.isEmpty, !Wait.said(now, in: live.saying ?? "") {
      self = .step(now)
    } else if working {
      self = .onIt
    } else {
      self = .stopped
    }
  }

  // Chat.tsx's: its words whitespace-folded hold the step, less a trailing ellipsis.
  static func said(_ step: String, in saying: String) -> Bool {
    if saying.isEmpty { return false }
    let folded = saying.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    let bare = step.hasSuffix("\u{2026}") ? String(step.dropLast()) : step
    return folded.contains(bare)
  }

  var words: String {
    switch self {
    case .answer: "Waiting for its answer"
    case .cantRun(let why): "It can't run: \(why)"
    case .permission: "Waiting on a permission prompt"
    case .queued: "Queued: it gets this when it's done with what it's on"
    case .step(let now): now
    case .onIt: "On it"
    case .stopped: "It stopped without answering"
    }
  }

  // At work on it or about to be: the line leads with the spinner.
  var busy: Bool {
    switch self {
    case .queued, .step, .onIt: true
    default: false
    }
  }
  // The link to its page on claude.ai, where it has one: "Answer it on claude.ai" on a permission prompt, else "Watch it on claude.ai".
  var link: String? {
    switch self {
    case .answer, .cantRun: nil
    case .permission: "Answer it on claude.ai"
    default: "Watch it on claude.ai"
    }
  }
}

enum Asking {
  // Whether an item's More offers Ask your agent. A PR's does. An issue's only once it's known to be unresolved and from
  // an author who isn't blocked, as Detail.tsx: no agent reads a blocked author's items, and the desk's ask doesn't check.
  static func offered(_ card: Card, blockedAuthor: Bool?, landed: Bool) -> Bool {
    card.isPR || (landed && card.resolved == nil && blockedAuthor != true)
  }

  static let off = "Your agent is off in Settings → Agent, so nothing is sent."

  // "api#4127": an id without its owner (format.ts's shortId).
  static func shortId(_ id: String) -> String {
    id.replacingOccurrences(of: #"^[^/]+/"#, with: "", options: .regularExpression)
  }

  // The box's own words while it's empty: with nothing asked yet, they're all the page says.
  static func placeholder(_ item: String?) -> String {
    item.map { "Ask or tell it something about \(shortId($0))" } ?? "Ask or tell it something"
  }

  // "plan.ts:20–23", ", removed" for a removed line (view.ts's lineName() and linesLabel()).
  static func linesLabel(path: String, line: Int, side: String, start: (line: Int, side: String)? = nil, note: Bool = false, agent: String = "Claude") -> String {
    let name = "\(Diff.splitPath(path).name):\(start.map { "\($0.line)\u{2013}" } ?? "")\(line)"
    if note { return "\(agent)'s note on \(name)" }
    return side == "old" && (start == nil || start?.side == "old") ? "\(name), removed" : name
  }

  static func linesLabel(_ l: Ask.Lines, agent: String) -> String {
    let start = l.start.flatMap { s in s.line.map { (line: $0, side: s.side ?? "new") } }
    return linesLabel(path: l.path ?? "", line: l.line ?? 0, side: l.side ?? "new", start: start, note: l.note == true, agent: agent)
  }

  // Under your words: when, the item's ref, and where in it: "3h · notes-app#12 · on a thread".
  static func meta(_ a: Ask, now: Date, agent: String) -> [String] {
    var out = [Words.sinceText(a.at, now: now)]
    if let item = a.itemId { out.append(shortId(item)) }
    if let l = a.lines { out.append("on \(linesLabel(l, agent: agent))") }
    if (a.threadUrl ?? "").isEmpty == false { out.append("on a thread") }
    return out.filter { !$0.isEmpty }
  }

  // Your latest ask has no answer yet: the page menu's "Your agent · waiting".
  static func waiting(_ view: AsksView?) -> Bool { view?.asks.last.map { $0.answer == nil } ?? false }

  // MARK: <agent>'s work

  // A job's title: the PR's, the question you answered, or your ask's words in quotes, so they read as yours.
  static func workTitle(_ w: Work) -> String {
    let title = w.title ?? w.key
    return w.kind == "ask" ? "\u{201C}\(title)\u{201D}" : title
  }

  // Where it stands, as dotted parts: "Claude is reviewing it · try 2 of 3", "Failed 3 times: …".
  static func workPhrase(_ w: Work, agent: String, now: Date) -> [String] {
    let review = w.kind == "ai_review"
    let error = w.error ?? ""
    let attempts = w.attempts ?? 0
    if w.kind == "answer" {
      return ["Your answer to \(Words.fromName(w.from, start: false)) hasn't been picked up"] + (error.isEmpty ? [] : [error])
    }
    switch w.state {
    case "running":
      return [review ? "\(agent) is reviewing it" : "Your agent has it"] + (attempts > 1 ? ["try \(attempts) of \(Work.tries)"] : [])
    case "failed":
      return [(review && attempts > 1 ? "Failed \(attempts) times: " : "Failed: ") + error]
    default:
      guard let retry = Words.date(w.retryAt) else { return [review ? "Waiting its turn" : "Waiting for your agent"] }
      let again = retry > now ? "Tries again in \(Words.span(now, retry))" : "Tries again shortly"
      return [again] + (error.isEmpty ? [] : [error])
    }
  }

  // Since when: it started (running), it failed, else it was queued. An answer: since you gave it.
  static func workSince(_ w: Work) -> String? {
    if w.kind == "answer" { return w.queuedAt }
    return (w.state == "running" ? w.startedAt : w.state == "failed" ? w.finishedAt : nil) ?? w.queuedAt
  }

  static func canRetry(_ w: Work) -> Bool { w.state == "failed" && w.kind != "answer" }
}

// How your agent runs, as the chat's menus offer it (Chat.tsx's AGENT): its name, how freely it runs in its own words,
// and the models and levels of effort it lists until the desk has read the agent's own (no effort on OpenCode). Every
// agent takes a typed model.
struct AgentKind: Equatable, Sendable {
  let name: String
  let run: [String]  // bypass off, then on
  let models: [String]
  let efforts: [String]

  static func of(_ agent: String?) -> AgentKind {
    switch agent {
    case "codex": AgentKind(name: "Codex", run: ["Workspace only", "Full access"], models: [], efforts: ["low", "medium", "high", "xhigh"])
    case "opencode": AgentKind(name: "OpenCode", run: ["Refuse what asks", "Approve what asks"], models: [], efforts: [])
    default:
      AgentKind(
        name: "Claude Code", run: ["Ask first", "Bypass permissions"],
        models: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        efforts: ["low", "medium", "high", "xhigh", "max"])
    }
  }

  struct Choice: Equatable, Sendable, Decodable {
    let value: String
    let label: String
  }

  // A menu's choices: its own default ("") first, then what its command lists (`read`, once the desk has read it; until
  // then the few it knows), then the value in force if it lists none such.
  static func choices(_ known: [String], read: [Choice], current: String, none: String) -> [Choice] {
    let list = read.isEmpty ? known.map { Choice(value: $0, label: label($0)) } : read
    return [Choice(value: "", label: none)] + list
      + (current.isEmpty || list.contains { $0.value == current } ? [] : [Choice(value: current, label: current)])
  }

  // Claude Code's models by version, as the desk's Settings names them (CLAUDE_VERSIONS in src/settings.ts); an effort, capitalized.
  static let versions = [
    "claude-fable-5-2": "Fable 5.2", "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5",
  ]
  static func label(_ value: String) -> String {
    versions[value] ?? value.prefix(1).uppercased() + value.dropFirst()
  }

  // What a trigger says: the pick's label, or a word for the agent's own default, so the three fit a narrow line.
  static func said(_ choices: [Choice], value: String, none: String) -> String {
    value.isEmpty ? none : choices.first { $0.value == value }?.label ?? value
  }

  func models(_ current: String, read: [Choice] = []) -> [Choice] {
    AgentKind.choices(models, read: read, current: current, none: "Default model")
  }
  func efforts(_ current: String, read: [Choice] = []) -> [Choice] {
    AgentKind.choices(efforts, read: read, current: current, none: "Default effort")
  }
}
