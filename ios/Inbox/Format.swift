import Foundation

// The window's words, as web/src/format.ts, view.ts and notices.ts write them: ages, times, who asks, what a row says
// after its ref, the snooze options and the system's bubbles. Keep these in step with those files.

enum Words {
  // Both of the desk's time formats: its own (with milliseconds) and GitHub's (without).
  static func date(_ at: String?) -> Date? {
    guard let at, !at.isEmpty else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: at) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: at)
  }

  // "12m", "5h", "3d"
  static func age(_ at: String?, now: Date) -> String {
    guard let then = date(at) else { return "" }
    return span(then, now)
  }

  // The time from one moment to a later one, as age() says it.
  static func span(_ then: Date, _ now: Date) -> String {
    let m = max(0, Int((now.timeIntervalSince(then) / 60).rounded()))
    if m < 60 { return "\(m)m" }
    // Rounded before the switch, so 47.6h and 48.3h both read "2d".
    let h = Int((Double(m) / 60).rounded())
    if h < 48 { return "\(h)h" }
    let d = Int((Double(m) / 1440).rounded())
    // Months past 45 days, as "mo": "m" is minutes.
    return d <= 45 ? "\(d)d" : "\(d / 30)mo"
  }

  // "just now" in the first minute, then as age(): for a single time on its own.
  static func sinceText(_ at: String?, now: Date) -> String {
    guard let then = date(at) else { return "" }
    return then > now.addingTimeInterval(-60) ? "just now" : age(at, now: now)
  }

  // "40s ago", "5m ago"
  static func ago(_ at: String?, now: Date) -> String {
    guard let then = date(at) else { return "" }
    let s = max(0, Int(now.timeIntervalSince(then).rounded()))
    if s < 60 { return "\(s)s ago" }
    let m = Int((Double(s) / 60).rounded())
    if m < 60 { return "\(m)m ago" }
    let h = Int((Double(s) / 3600).rounded())
    if h < 48 { return "\(h)h ago" }
    return "\(Int((Double(s) / 86_400).rounded()))d ago"
  }

  // "14:30" today, "Tue 9:00" within a week, else "Nov 12 9:00".
  static func when(_ at: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
    guard let d = date(at) else { return "" }
    let parts = calendar.dateComponents([.hour, .minute], from: d)
    let time = "\(parts.hour ?? 0):" + String(format: "%02d", parts.minute ?? 0)
    if calendar.isDate(d, inSameDayAs: now) { return time }
    let f = DateFormatter()
    f.calendar = calendar
    f.timeZone = calendar.timeZone
    f.locale = calendar.locale ?? .current
    f.setLocalizedDateFormatFromTemplate(abs(d.timeIntervalSince(now)) < 6 * 86_400 ? "EEE" : "MMMd")
    return "\(f.string(from: d)) \(time)"
  }

  // Either of the desk's own sessions, the coordinator or your agent, under any name it has gone by (types.ts's isCoordinator).
  static func isCoordinator(_ from: String?) -> Bool {
    from == "Inbox coordinator" || from == "Review Desk coordinator" || from == "Inbox agent"
  }

  // Who asks: the coordinator is "your agent"; every other session goes by the name it gave itself.
  static func fromName(_ from: String?, start: Bool = true) -> String {
    isCoordinator(from) ? (start ? "Your agent" : "your agent") : (from ?? "")
  }

  static let maxAsk = 2000  // your answer to an agent's question, a note to yourself (src/desk.ts's MAX_ASK)

  // An item on GitHub by its id alone (format.ts's issueUrl): GitHub sends a PR's number on to its pull page.
  static func issueURL(_ id: String) -> URL? {
    let parts = id.split(separator: "#", maxSplits: 1).map(String.init)
    guard parts.count == 2, Int(parts[1]) != nil, parts[0].range(of: #"^[\w.-]+/[\w.-]+$"#, options: .regularExpression) != nil else { return nil }
    return URL(string: "https://github.com/\(parts[0])/issues/\(parts[1])")
  }

  static func capitalized(_ s: String) -> String {
    s.prefix(1).uppercased() + s.dropFirst()
  }

  // A sentence of the desk's own words: a capital first, and a full stop unless it ends itself.
  static func sentence(_ s: String) -> String {
    capitalized(s) + (s.last.map { ".?!".contains($0) } == true ? "" : ".")
  }

  // A PR's size by the lines it changes, as format.ts's sizeOf(): its bars and what they say.
  static func sizeOf(add: Int, del: Int) -> (bars: Int, label: String) {
    let n = add + del
    let (bars, word) = n < 30 ? (1, "Tiny") : n < 200 ? (2, "Small") : n < 600 ? (3, "Medium") : (4, "Large")
    return (bars, "\(word) change: +\(add) \u{2212}\(del)")
  }

  static func plural(_ n: Int, _ word: String) -> String {
    "\(n) \(word)\(n == 1 ? "" : "s")"
  }

  static let until: [String: String] = [
    "ci": "CI passes",
    "push": "new commits",
    "approved": "it's approved",
    "ready": "it's ready for review",
    "conflict": "the merge conflict is fixed",
  ]

  // A row's one call to action, as CardRow's CTA names it.
  static let cta: [String: String] = [
    "ready": "Ready for review",
    "reviewers": "Add reviewers",
    "reply": "Reply",
    "handoff": "Hand off for merge",
  ]

  // An opened page's call to action: the row's own, then what the window's review offers where a row has none.
  static let act: [String: String] = cta.merging(["approve": "Approve", "comment": "Comment", "handoff": "Hand off for merge", "fix": "Make PR with fix"]) { a, _ in a }

  // The More menu's GitHub writes (Card.actions), by label, as More.tsx's MORE; an issue's close is "Close issue".
  static let more: [String: String] = [
    "close": "Close", "draft": "Convert to draft", "ready": "Ready for review", "merge": "Merge now", "reopen": "Reopen",
    "request_changes": "Request changes", "rerequest": "Re-request review", "unrequest": "Remove me as a reviewer",
  ]

  // What each says it did, as App.tsx's DID; its toast adds ": <ref>".
  static let did: [String: String] = [
    "close": "Closed on GitHub", "draft": "Converted to a draft on GitHub", "merge": "Merged on GitHub", "reopen": "Reopened on GitHub",
    "request_changes": "Requested changes on GitHub", "rerequest": "Asked them to review it again on GitHub",
    "unrequest": "Took you off its reviewers on GitHub",
  ]

  // "a", "a and b", "a, b and 2 more": src/stage.ts's andMore().
  static func andMore(_ names: [String]) -> String {
    let shown = names.prefix(2)
    return names.count > 2 ? "\(shown.joined(separator: ", ")) and \(names.count - 2) more" : shown.joined(separator: " and ")
  }

  // Where a conversation is: "src/auth.ts:42", "src/auth.ts, outdated", or "on the PR" (Conversation.tsx's where()).
  static func place(_ c: Conversation) -> String {
    guard let path = c.path, !path.isEmpty else { return "on the PR" }
    return path + (c.line.map { $0 > 0 ? ":\($0)" : "" } ?? "") + (c.outdated == true ? ", outdated" : "")
  }

  // A comment as text: GitHub's own markup taken off (HTML comments and tags, a heading's hashes), since none is drawn.
  static func saidText(_ said: String?) -> String {
    var s = said ?? ""
    for (pattern, with) in [(#"<!--[\s\S]*?-->"#, ""), (#"</?[a-zA-Z][^>\n]*>"#, ""), (#"(?m)^[ \t]*#{1,6}[ \t]+"#, ""), (#"\n{3,}"#, "\n\n")] {
      s = s.replacingOccurrences(of: pattern, with: with, options: .regularExpression)
    }
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  // Your agent's take, split at its first ": " into the call (drawn bold) and why; without one it's all plain.
  static func takeSplit(_ take: String) -> (call: String?, rest: String) {
    guard let at = take.range(of: ": ") else { return (nil, take) }
    return (String(take[..<at.lowerBound]), String(take[at.upperBound...]))
  }

  // "Reply to kai", "Sent your reply to kai": to whoever spoke last, other than you; where only you have, no name.
  static func replyTo(_ lead: String, _ c: Conversation, me: String) -> String {
    let who = c.comments.last { !($0.author ?? "").isEmpty && $0.author?.lowercased() != me.lowercased() }?.author
    return who.map { "\(lead) to \($0)" } ?? lead
  }

  static let sessionKind: [String: String] = ["cli": "CLI", "background": "Background", "desktop": "Desktop", "codex": "Codex"]
  static let sessionAction: [String: String] = [
    "kick": "Kick", "resume": "Resume in background", "attach": "Copy attach command", "open": "Open",
  ]

  static let verdict: [String: String] = ["look": "Look closely", "skim": "Skim it", "skip": "Skip it"]

  // MARK: An issue's page (web/src/components/Detail.tsx)

  // What kind of issue its pre-review says it is: "A bug", without its full stop.
  static func issueKind(_ kind: String?) -> String {
    ["bug": "A bug", "feature": "A feature request", "question": "A question"][kind ?? ""] ?? "An issue"
  }

  static let bucketLabel = ["now": "Now", "today": "Today", "blocked": "Blocked", "later": "Later", "fyi": "FYI", "hide": "Hidden"]

  // Where an issue sits and from which board, and why it moved from where the rule put it: Detail.tsx's why-block,
  // less its rule trace. `place` is the bold lead; nil where the card's own why already says it all.
  static func placement(_ d: ItemDetail, board: (String) -> String, agent: String) -> (place: String?, rest: String, moved: String?) {
    let card = d.card
    guard let main = d.placements.first(where: { $0.board == card.board }) ?? d.placements.first else { return (nil, "", nil) }
    let label = { (b: String?) in bucketLabel[b ?? ""] ?? (b ?? "") }
    let judged = main.judge?.bucket.map { !$0.isEmpty && $0 == main.ruleBucket } ?? false
    let sorter = (main.judge?.by).map { "automation \($0)" } ?? agent
    let why = main.why ?? ""
    var place: String?
    var rest = ""
    if card.resolved != nil || why != (card.why ?? "") || judged {
      place = (card.resolved != nil ? "Otherwise " : "") + (["now", "today"].contains(main.bucket ?? "") ? "In the Inbox" : label(main.bucket))
      rest = ", from the \(board(main.board ?? "")) board" + (judged && !(main.judge?.why ?? "").isEmpty ? ", sorted by \(sorter)" : "")
        + (!why.isEmpty && why != card.why ? ": \(why)" : "")
    }
    let moved = main.demoted.map { because in
      "\(judged ? (sorter.hasPrefix("a") ? "A" + sorter.dropFirst() : sorter) : "The rule") said \(label(main.ruleBucket).lowercased()); it moved to \(label(main.bucket).lowercased()) because \(because.prefix(1).lowercased() + because.dropFirst())."
    }
    return (place, rest, moved)
  }

  // Who placed it (view.ts's PLACED_BY).
  static func placedBy(_ by: String?, agent: String) -> String? {
    switch by {
    case "hard": "placed by a hard rule"
    case "pin": "kept up by its pin"
    case "claude": "sorted by \(agent)"
    case "automation": "sorted by an automation"
    default: nil
    }
  }

  // How you were asked (Detail.tsx's request()).
  static func asked(_ m: ItemDetail.Signals.Me) -> String {
    if m.author == true { return "your PR" }
    if m.requested != true { return m.assignee == true ? "assigned to you" : "not requested" }
    var parts = [m.requestedDirect == true ? "you, by name" : "your team @\(m.requestedTeam ?? "")"]
    if let by = m.requestedBy, !by.isEmpty { parts.append("by \(by)\(m.requestedByBot == true ? " (bot)" : "")") }
    if m.requestedCodeowner == true { parts.append("CODEOWNERS") }
    if let h = m.requestedHours, h >= 0 {
      parts.append((h < 1 ? "\(Int((h * 60).rounded()))m" : h < 48 ? "\(Int(h.rounded()))h" : "\(Int((h / 24).rounded()))d") + " ago")
    }
    return parts.joined(separator: ", ")
  }

  // MARK: The AI review's words (src/sections.ts, AiSection in web/src/components/Review.tsx)

  static let fit: [String: String] = ["partial": "Not quite what the description says", "differs": "Not what the description says"]

  // A summary's first sentence and what's left, never cut inside `code`; no lead when it opens with a list or code.
  // "e.g." and the like don't end a sentence. src/prose.ts's lead(), on plain text.
  static func lead(_ text: String) -> (first: String, rest: String) {
    let all = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let cut = all.range(of: #"\n[ \t]*\n"#, options: .regularExpression)
    let head = String(cut.map { all[..<$0.lowerBound] } ?? all[...])
    let after = cut.map { String(all[$0.upperBound...]) } ?? ""
    if head.isEmpty || head.range(of: #"^\s*([-*+] |\d+[.)] |```|#)"#, options: .regularExpression) != nil { return ("", all) }
    let whole = head as NSString
    let end = try? NSRegularExpression(pattern: #"(?<!\b(?:e\.g|i\.e|etc|vs|cf))[.!?]["')\]]?(?=\s)"#, options: .caseInsensitive)
    for m in end?.matches(in: head, range: NSRange(location: 0, length: whole.length)) ?? [] {
      let before = whole.substring(to: m.range.location)
      if before.filter({ $0 == "`" }).count % 2 == 1 { continue }  // inside code
      let first = whole.substring(to: m.range.location + m.range.length)
      let more = whole.substring(from: m.range.location + m.range.length).trimmingCharacters(in: .whitespacesAndNewlines)
      return (first, [more, after].filter { !$0.isEmpty }.joined(separator: "\n\n"))
    }
    return (head, after)
  }

  private static func minutes(_ at: String?, now: Date) -> Int {
    max(1, Int((abs((date(at) ?? now).timeIntervalSince(now)) / 60).rounded()))
  }

  // While it's being written. Past its first couple of minutes, or on another try, the line says so rather than
  // promise the notes soon.
  static func reviewing(agent: String, job: Job?, now: Date) -> String {
    let run = job?.state == "running" ? job : nil
    let tries = (run?.attempts ?? 0) > 1 ? ", try \(run?.attempts ?? 0) of \(Work.tries)" : ""
    var so = ""
    if let started = date(run?.startedAt), now.timeIntervalSince(started) >= 120 { so = ", \(plural(minutes(run?.startedAt, now: now), "minute")) so far" }
    return so.isEmpty && tries.isEmpty
      ? "\(agent) is reviewing it. The notes land in the code below in a minute or two." : "\(agent) is reviewing it\(so)\(tries)."
  }

  // A try that failed says so and when your agent tries again; anything else (AI reviews paused) is the desk's own words.
  static func reviewFailed(_ error: String, job: Job?, agent: String, now: Date) -> String {
    guard let job, let its = job.error, !its.isEmpty, its == error else { return error }
    let said = error.hasSuffix(".") ? String(error.dropLast()) : error
    let lead = (job.attempts ?? 0) > 1 && job.state == "failed" ? "The AI review failed \(job.attempts ?? 0) times: " : "The AI review failed: "
    var again = ""
    if job.state == "queued", let retry = date(job.retryAt) {
      again = retry > now ? " \(agent) tries again in \(plural(minutes(job.retryAt, now: now), "minute"))." : " \(agent) tries again shortly."
    }
    return "\(lead)\(said).\(again)"
  }

  // Each concern is also a note in the code; they're listed under the verdict only when the notes can't sit there.
  static func listsConcerns(stale: Bool, notes: Int) -> Bool { stale || notes == 0 }

  // "snoozed until Sat 9:00 or new activity".
  static func clearedText(_ c: Card, now: Date = Date()) -> String {
    switch c.status {
    case "muted": return "muted"
    case "done": return "done until someone else acts"
    case "snoozed":
      if let w = c.snoozeWhen, let words = until[w] { return "snoozed until \(words)" }
      if c.snoozeUntil != nil { return "snoozed until \(when(c.snoozeUntil, now: now)) or new activity" }
      return "snoozed until activity"
    default: return ""
    }
  }

  // The same fact in other words, as rules write whys: "conflicts with main", "red CI", "you requested changes", "2 approvals".
  static let meanings = [
    #"conflict"#,
    #"\bCI\b.*\b(?:fail\w*|red|broken)\b|\b(?:fail\w*|red|broken)\b.*\bCI\b"#,
    #"\bchanges requested\b|\brequested changes\b"#,
    #"\bapprov(?:ed|als?)\b"#,
  ]

  // Whether a why already says a fact, in its words or in other words for the same thing (view.ts's says()).
  static func says(_ why: String, _ fact: String) -> Bool {
    if fact.isEmpty || why.lowercased().contains(fact.lowercased()) { return true }
    let has = { (s: String, pattern: String) in s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
    return meanings.contains { has(why, $0) && has(fact, $0) }
  }

  // One event in plain words, without its time: "alice approved", "CI went red". `me` reads as "you".
  // A resolved PR's line on its review, as view.ts's resolvedHead(): who merged or closed it, from its activity.
  static func resolvedHead(_ events: [ActivityEvent], _ resolved: String, me: String) -> String {
    guard resolved == "merged" || resolved == "closed", let actor = events.first(where: { $0.kind == resolved })?.actor, !actor.isEmpty else {
      return resolved
    }
    return "\(resolved) by \(!me.isEmpty && actor.lowercased() == me.lowercased() ? "you" : actor)"
  }

  static func eventText(_ e: ActivityEvent, me: String) -> String {
    let d = e.data ?? [:]
    let actor = e.actor ?? ""
    let who = !me.isEmpty && actor.lowercased() == me.lowercased() ? "you" : actor
    let whom = d["type"]?.text == "team" ? "@\(d["reviewer"]?.text ?? "")" : "you"
    switch e.kind {
    case "new": return "first seen"
    case "review_requested": return "\(who.isEmpty ? "asked" : "\(who) asked") \(whom)"
    case "request_removed": return "request to \(whom) removed"
    case "reviewed":
      let said = ["approved": "approved", "changes_requested": "requested changes", "commented": "commented"]
      return "\(who) \(said[d["state"]?.text ?? ""] ?? "reviewed")"
    case "pushed": return who.isEmpty ? "new commits" : "\(who) pushed"
    case "ci":
      let to = d["to"]?.text
      return to == "red" ? "CI went red" : to == "green" ? "CI went green" : "CI started"
    case "commented": return "\(who) commented"
    case "merged": return who.isEmpty ? "merged" : "\(who) merged it"
    case "closed": return "closed"
    case "reopened": return "reopened"
    case "mentioned": return d["reason"]?.text == "team_mention" ? "your team was mentioned" : "you were mentioned"
    case "assigned": return "assigned to you"
    case "conflict": return d["base"]?.truthy == true ? "conflicts with \(d["base"]!.text)" : "merge conflict"
    case "resolved": return "resolved: \(d["reason"]?.text ?? "")"
    case "unresolved": return "came back (was \(d["was"]?.text ?? ""))"
    case "blocked": return "blocked by \(d["by"]?.text ?? "")"
    case "unblocked":
      if d["merged"]?.truthy == true { return "unblocked: \(d["merged"]!.text) merged" }
      if d["closed"]?.truthy == true { return "needs \(d["closed"]!.text), closed without merging" }
      return "unblocked"
    default: return e.kind ?? ""
    }
  }
}

// MARK: Checks (view.ts's checkDot() and checkGroups())

// How a check is doing, worst first: failing, failing but not required, running, passing, skipped.
enum CheckDot: Int, Sendable {
  case red, amber, yellow, green, grey

  init(_ c: Checks.Check) {
    switch c.state {
    case "failing", "cancelled": self = c.optional == true ? .amber : .red
    case "running": self = .yellow
    case "passing": self = .green
    default: self = .grey
    }
  }

  // Review.tsx's DOT_WORDS.
  var words: String {
    switch self {
    case .red: "failing"
    case .amber: "failing, not required"
    case .yellow: "running"
    case .green: "passing"
    case .grey: "skipped"
    }
  }

  var quiet: Bool { self == .green || self == .grey }
}

struct CheckGroup: Identifiable, Sendable {
  let name: String
  let dot: CheckDot  // its worst check's, skipped ones aside
  let checks: [Checks.Check]
  var id: String { name }

  // A shard's mark at a name's end: "(1/3)", "[2]", "#4", " 3", "shard 2 of 5".
  private static let shard = #"\s*(?:\([^()]*\)|\[[^\]]*\]|#?\d+(?:\s*(?:/|of)\s*\d+)?|shard\s*\d+(?:\s*(?:/|of)\s*\d+)?)$"#

  // Checks that share a name but for a shard's mark are one row, worst first; one alone keeps its whole name.
  static func of(_ list: [Checks.Check]) -> [CheckGroup] {
    var keys: [String] = []
    var by: [String: [Checks.Check]] = [:]
    for c in list {
      let name = c.name ?? ""
      let cut = name.range(of: shard, options: [.regularExpression, .caseInsensitive]).map { String(name[..<$0.lowerBound]) } ?? name
      let trimmed = cut.trimmingCharacters(in: .whitespaces)
      let key = trimmed.isEmpty ? name : trimmed
      if by[key] == nil { keys.append(key) }
      by[key, default: []].append(c)
    }
    let groups = keys.map { key in
      let checks = by[key] ?? []
      let dot = checks.map(CheckDot.init).filter { $0 != .grey }.min { $0.rawValue < $1.rawValue } ?? .grey
      return CheckGroup(name: checks.count == 1 ? checks[0].name ?? key : key, dot: dot, checks: checks)
    }
    // As the desk listed them within a dot.
    return groups.enumerated().sorted { ($0.element.dot.rawValue, $0.offset) < ($1.element.dot.rawValue, $1.offset) }.map(\.element)
  }

  // Past this many rows the passing and skipped ones wait behind one line (Review.tsx's SIDE_ROWS).
  static let rows = 6
}

// MARK: Snooze

struct SnoozeOption: Identifiable, Equatable {
  let until: String
  let label: String
  let toast: String
  var id: String { until }

  static let times: [SnoozeOption] = [
    .init(until: "1h", label: "1 hour", toast: "for an hour (or until new activity)"),
    .init(until: "3h", label: "3 hours", toast: "for 3 hours (or until new activity)"),
    .init(until: "tomorrow", label: "Tomorrow 9:00", toast: "until tomorrow 9:00 (or new activity)"),
    .init(until: "monday", label: "Monday 9:00", toast: "until Monday 9:00 (or new activity)"),
  ]
  static let activity = SnoozeOption(until: "activity", label: "Until activity", toast: "until someone acts")

  // What this item can wait on, as the desk says (wake_on), in its order; a value this app doesn't know is left out.
  static func waits(_ c: Card) -> [SnoozeOption] {
    (c.wakeOn ?? []).compactMap { u in
      Words.until[u].map { .init(until: u, label: "Until \($0)", toast: "until \($0)") }
    }
  }

  // The times, then what this item can wait on.
  static func all(_ c: Card) -> [SnoozeOption] { times + [activity] + waits(c) }
}

// MARK: A note's reminder (Note.tsx's WHEN)

enum Remind {
  // None, a time from now as a snooze reads it, or one you pick.
  static let choices: [(value: String, label: String)] = [
    ("", "No reminder"), ("1h", "In 1 hour"), ("3h", "In 3 hours"), ("tomorrow", "Tomorrow 9:00"), ("monday", "Monday 9:00"), ("pick", "Pick a time…"),
  ]

  // What /api/notes takes as `remind`: "" for none, the choice itself, or the picked time as the desk writes times.
  // A reminder left where it was goes back as the desk sent it, so the desk sees it unchanged.
  static func value(_ pick: String, at: Date, was: Note? = nil) -> String {
    guard pick == "pick" else { return pick }
    if let old = was?.remindAt, Words.date(old) == at { return old }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: at)
  }

  // Where Pick a time… starts: the next full hour.
  static func nextHour(_ now: Date, calendar: Calendar = .current) -> Date {
    calendar.nextDate(after: now, matching: DateComponents(minute: 0, second: 0), matchingPolicy: .nextTime) ?? now.addingTimeInterval(3600)
  }
}

// MARK: Bubbles (what's wrong with the system), as notices.ts orders them

struct Notice: Identifiable, Equatable {
  enum Tone { case red, amber }
  enum Fix: Equatable { case retry, sync }

  let id: String  // one per condition, so a dismissal names it
  let sig: String  // what it is now: a dismissed one comes back once this changes
  var tone: Tone?
  let title: String
  var text: String?
  var fix: Fix?
  var fixLabel: String?
  var busy = false
  var transient = false
}

struct Conditions {
  var offline = false
  var local = false  // the desk is on this machine (the Simulator on the desk's Mac): the window's own words hold
  var starting: String?
  var refused: String?  // the desk answered a read with a refusal, or with what this app can't read
  var broken: String?
  var overview: Overview?
  var paused: QueueView.Paused?
  var agent = "Claude"
}

enum Notices {
  // In the order they matter. While the desk is unreachable, what it said last is stale: only that it's down is said.
  static func of(_ c: Conditions, now: Date = Date()) -> [Notice] {
    if c.offline {
      return [
        c.local
          ? Notice(
            id: "desk", sig: "offline", tone: .red, title: "The desk isn't running",
            text: "Start it with `inbox serve` or open the desktop app.", fix: .retry, fixLabel: "Retry")
          : Notice(
            id: "desk", sig: "offline", tone: .red, title: "The desk can't be reached",
            text: "Check this phone has Tailscale on, and that the desk's computer is awake.", fix: .retry, fixLabel: "Retry")
      ]
    }
    if let starting = c.starting {
      return [Notice(id: "desk", sig: "starting", title: "The desk is starting", text: starting, fix: .retry, fixLabel: "Retry")]
    }
    // As stale as when it's away: what it said last isn't what it would say now.
    if let refused = c.refused {
      let owner = refused.contains("desk's owner") ? " Sign this phone in to Tailscale as the desk's owner." : ""
      return [
        Notice(
          id: "desk", sig: "refused:\(refused)", tone: .red, title: "Can't read the desk", text: Words.sentence(refused) + owner, fix: .retry,
          fixLabel: "Retry")
      ]
    }
    var out: [Notice] = []
    let errors = c.overview?.configErrors.count ?? 0
    if let broken = c.broken {
      let why = broken.replacingOccurrences(of: #"^config has errors:\s*"#, with: "", options: .regularExpression)
      out.append(
        Notice(
          id: "rules", sig: "broken", tone: .red, title: "Your rules don't load",
          text: "There's nothing on your desk until they do. \(why)"))
    } else if errors > 0 {
      out.append(
        Notice(
          id: "rules", sig: "errors:\(errors)", tone: .amber, title: "Your rules have \(errors) \(errors == 1 ? "error" : "errors")",
          text: "Your desk uses the last version that worked."))
    }
    if let p = c.paused {
      out.append(
        Notice(
          id: "agent", sig: p.who ?? "", tone: .red, title: p.who == "claude" ? "\(c.agent) is paused" : "AI reviews are paused",
          text: p.why))
    }
    // Rate limited has no fix: the desk skips every sync until the limit resets, so a retry would only seem to run.
    if let o = c.overview, let error = o.syncError, !error.isEmpty {
      if o.connectors.contains(where: { $0.status == "paused" }) {
        let reset = o.rateLimit?.resetAt
        out.append(
          Notice(
            id: "sync", sig: "limited", tone: .amber, title: "GitHub's rate limit is used up",
            text: reset.map { "Syncing starts again at \(Words.when($0, now: now))." } ?? error))
      } else {
        let syncing = o.syncing == true
        out.append(
          Notice(
            id: "sync", sig: "failed", tone: .red, title: "Sync failed", text: error, fix: .sync,
            fixLabel: syncing ? "Syncing…" : "Try again", busy: syncing))
      }
    }
    return out
  }
}

// MARK: The filter (view.ts's parseFilter(), matches() and filterPeople(); Filter.tsx's suggest())

// A list's filter: words match a row's title, repo, author or ref; author:dana (who it's from) and involves:dana
// (anyone on it: asked, reviewed or said something) pick people. A term followed by a space is finished: a pill.
enum Filter {
  struct Term: Equatable, Sendable {
    var key: String  // "author" | "involves"
    var who: String
    var done = false  // followed by a space: a pill, no longer being typed
  }

  struct Person: Equatable, Sendable {
    var login: String
    var author: Bool  // wrote one of the rows
  }

  // What the word being typed can turn into; login "": the key alone, to pick its person next.
  struct Pick: Equatable, Identifiable, Sendable {
    var key: String
    var login: String
    var id: String { "\(key):\(login)" }
  }

  static let keys = ["author", "involves"]
  static let label = ["author": "Author", "involves": "Involves"]
  static let help = ["author": "who opened it", "involves": "anyone on it: asked, reviewed or said something"]

  // Each word with the space after it, as view.ts walks them (/(\S+)(\s*)/g).
  private static func words(_ s: String) -> [(word: String, space: String)] {
    var out: [(String, String)] = []
    var word = ""
    var space = ""
    for ch in s {
      if ch.isWhitespace {
        if !word.isEmpty { space.append(ch) }
      } else {
        if !space.isEmpty {
          out.append((word, space))
          word = ""
          space = ""
        }
        word.append(ch)
      }
    }
    if !word.isEmpty { out.append((word, space)) }
    return out
  }

  private static func term(_ word: String) -> (key: String, who: String)? {
    guard let colon = word.firstIndex(of: ":") else { return nil }
    let key = word[..<colon].lowercased()
    guard keys.contains(key) else { return nil }
    return (key, String(word[word.index(after: colon)...]))
  }

  // A filter's terms and its free text. A term still being typed (the last word) matches as you type it.
  static func parse(_ s: String) -> (terms: [Term], text: String) {
    var terms: [Term] = []
    var text: [String] = []
    for (word, space) in words(s) {
      if let t = term(word) {
        terms.append(Term(key: t.key, who: t.who.hasPrefix("@") ? String(t.who.dropFirst()) : t.who, done: !space.isEmpty))
      } else {
        text.append(word)
      }
    }
    return (terms, text.joined(separator: " "))
  }

  // What the filter's box holds after its pills: the filter without its finished terms, as typed.
  static func rest(_ s: String) -> String {
    words(s).filter { !(term($0.word) != nil && !$0.space.isEmpty) }.map { $0.word + $0.space }.joined()
  }

  // A filter from its pills and what's typed after them.
  static func of(_ terms: [Term], _ rest: String) -> String {
    terms.map { "\($0.key):\($0.who) " }.joined() + rest
  }

  static func isYou(_ who: String) -> Bool { who == "you" || who == "me" }

  static func matches(_ c: Card, _ q: String, me: String) -> Bool {
    if q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
    let (terms, text) = parse(q)
    let has = { (login: String?, who: String) in (login ?? "").lowercased().contains(who) }
    let fits = terms.allSatisfy { t in
      let who = t.who.lowercased()
      if who.isEmpty { return true }  // a key with no one yet filters nothing
      if t.key == "author" { return isYou(who) ? c.by == "you" : has(c.author, who) || has(c.by, who) }
      let people = c.people ?? [c.author ?? ""]
      return isYou(who) ? c.by == "you" || people.contains(me) : people.contains { has($0, who) }
    }
    return fits && (text.isEmpty || "\(c.title)\n\(c.repo)\n\(c.author ?? "")\n\(c.shortRef)".lowercased().contains(text.lowercased()))
  }

  // A note has only its words: the filter as typed, pills and all (Queue.tsx's mine()).
  static func matches(_ n: Note, _ q: String) -> Bool {
    let words = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return words.isEmpty || (n.text ?? "").lowercased().contains(words)
  }

  // Who the filter can suggest: you first (PeopleFilter.tsx's), then everyone on these rows, most rows first, and
  // whether they wrote any of them. A bot that wrote its own PR is left out.
  static func people(_ cards: [Card], me: String) -> [Person] {
    var seen: [String: (n: Int, author: Bool)] = [:]
    for c in cards {
      let by = c.by == "you" ? me : (c.by ?? "")
      for p in Set((c.people ?? [c.author ?? ""]) + [by]) {
        if p.isEmpty || (c.authorBot == true && p == c.author) { continue }
        let s = seen[p] ?? (0, false)
        seen[p] = (s.n + 1, s.author || p == by || p == c.author)
      }
    }
    let others = seen.filter { $0.key != me }
      .sorted { $0.value.n != $1.value.n ? $0.value.n > $1.value.n : $0.key.localizedStandardCompare($1.key) == .orderedAscending }
      .map { Person(login: $0.key, author: $0.value.author) }
    return (me.isEmpty ? [] : [Person(login: me, author: true)]) + others
  }

  // Every row the desk holds, whatever page it's on: who the filter suggests is the same on each.
  static func cards(_ v: QueueView) -> [Card] {
    (v.inbox?.urgent ?? []) + (v.inbox?.standard ?? []) + (v.inbox?.fyi ?? []) + v.cleared + v.resolved + v.hidden + (v.sections?.blocked ?? [])
  }

  // The word being typed: what's after the last space of the box.
  static func word(_ rest: String) -> String {
    String(rest.reversed().prefix { !$0.isWhitespace }.reversed())
  }

  // A key's people (up to 8), or for a name, who it is as author and as anyone involved (up to 4 people); an empty
  // word offers the two keys.
  static func suggest(_ word: String, _ people: [Person]) -> [Pick] {
    if let t = term(word) {
      let q = (t.who.hasPrefix("@") ? String(t.who.dropFirst()) : t.who).lowercased()
      return people.filter { (t.key == "involves" || $0.author) && (q.isEmpty || $0.login.lowercased().contains(q)) }.prefix(8)
        .map { Pick(key: t.key, login: $0.login) }
    }
    let q = (word.hasPrefix("@") ? String(word.dropFirst()) : word).lowercased()
    if q.isEmpty { return keys.map { Pick(key: $0, login: "") } }
    let found = people.filter { $0.login.lowercased().contains(q) }.prefix(4)
    return found.filter(\.author).map { Pick(key: "author", login: $0.login) } + found.map { Pick(key: "involves", login: $0.login) }
  }

  // What the box offers now: for the word being typed, or the two keys while there's nothing else in it.
  static func offered(_ filter: String, _ people: [Person]) -> [Pick] {
    let rest = rest(filter)
    let word = word(rest)
    return !word.isEmpty || rest.trimmingCharacters(in: .whitespaces).isEmpty ? suggest(word, people) : []
  }

  // The filter after a pick: a person becomes a pill in the word's place; a key alone is typed out, for its person next.
  static func picked(_ p: Pick, in filter: String) -> String {
    let pills = parse(filter).terms.filter(\.done)
    let rest = rest(filter)
    let before = String(rest.dropLast(word(rest).count))
    return p.login.isEmpty ? of(pills, "\(before)\(p.key):") : of(pills + [Term(key: p.key, who: p.login)], before)
  }

  // The filter without its last pill (Backspace at the box's start), or without the one at `i` (its ×).
  static func dropped(_ i: Int? = nil, from filter: String) -> String {
    var pills = parse(filter).terms.filter(\.done)
    guard !pills.isEmpty else { return filter }
    pills.remove(at: i.map { min(max($0, 0), pills.count - 1) } ?? pills.count - 1)
    return of(pills, rest(filter))
  }
}

// MARK: The lists

enum Lists {
  // What the Inbox counts: Urgent and Standard, an agent's question and a session that needs you; less rows on their way off.
  static func inboxCount(_ v: QueueView, leaving: Set<String> = []) -> Int {
    let cards = (v.inbox?.urgent ?? []) + (v.inbox?.standard ?? [])
    return cards.filter { !leaving.contains($0.id) }.count + v.inquiries.filter { !leaving.contains($0.id) }.count
      + v.sessions.filter { $0.status == "active" && !leaving.contains($0.id) }.count
  }

  // The Archive's own group: what you did that took it off your desk, and what the world dealt with, newest first.
  // The one place a client sorts; every other list is in the desk's order.
  static func archive(_ v: QueueView) -> [Card] {
    let at = { (c: Card) in c.resolvedAt ?? c.doneAt ?? "" }
    return (v.cleared.filter { $0.status == "done" } + v.resolved).enumerated()
      .sorted { at($0.element) == at($1.element) ? $0.offset < $1.offset : at($0.element) > at($1.element) }
      .map(\.element)
  }

  static func cleared(_ v: QueueView) -> [Card] { v.cleared.filter { $0.status != "done" } }

  // Blocked's tree guide, from its rows' depths in the desk's order: per row, one per level (view.ts's treeGuides()):
  // ├ a branch with more under the same row, └ its last, │ the line past a deeper row, or nothing.
  enum Guide: Equatable, Sendable { case tee, end, rail, gap }

  static func treeGuides(_ depths: [Int]) -> [[Guide]] {
    // Whether a later row hangs at level k under the same row as this one does, before the tree climbs above k.
    let more = { (i: Int, k: Int) -> Bool in
      for d in depths[(i + 1)...] where d <= k { return d == k }
      return false
    }
    return depths.enumerated().map { i, d in
      (0..<max(d, 0)).map { l in l + 1 == d ? (more(i, d) ? .tee : .end) : more(i, l + 1) ? .rail : .gap }
    }
  }

  // Where a row on the Inbox can move: one section up or down (RowMenu.tsx's MOVES), each an action /api/act takes.
  static let sectionName = ["urgent": "Urgent", "standard": "Standard", "fyi": "FYI"]
  static func moves(_ c: Card) -> [String] {
    guard c.status == "active", c.inflight != true else { return [] }
    return sectionMoves[c.section ?? ""] ?? []
  }
  static let sectionMoves = ["urgent": ["standard"], "standard": ["urgent", "fyi"], "fyi": ["standard"]]
  static let sections = ["urgent", "standard", "fyi"]

  // A note's moves, as NoteMenu's: one section up or down from where it is; a due reminder leads Urgent whatever its section.
  static func moves(_ n: Note, now: Date) -> [String] {
    let due = Words.date(n.remindAt).map { $0 <= now } ?? false
    return sectionMoves[due ? "urgent" : (n.section ?? "standard")] ?? []
  }

  // FYI shows its first rows (Queue.tsx's FYI_SHOWN): the rest wait behind Show more until you ask, filter, or leave
  // the page. One row is never hidden alone, so the cut starts at two more.
  static let fyiShown = 5
  static func fyiCut(_ count: Int, all: Bool, filtering: Bool) -> Int? {
    !all && !filtering && count > fyiShown + 1 ? fyiShown : nil
  }

  // What a row in the Archive says after its ref: why it's there.
  static func archiveNote(_ c: Card) -> String { c.resolved ?? "done: back when someone else acts" }
  static func hiddenNote(_ c: Card) -> String { (c.why ?? "").isEmpty ? "hidden by your rules" : c.why! }
}
