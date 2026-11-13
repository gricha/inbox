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
    let m = max(0, Int((now.timeIntervalSince(then) / 60).rounded()))
    if m < 60 { return "\(m)m" }
    // Rounded before the switch, so 47.6h and 48.3h both read "2d".
    let h = Int((Double(m) / 60).rounded())
    if h < 48 { return "\(h)h" }
    return "\(Int((Double(m) / 1440).rounded()))d"
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

  static func isCoordinator(_ from: String?) -> Bool {
    from == "Inbox coordinator" || from == "Review Desk coordinator"
  }

  // Who asks: the coordinator is "your agent"; every other session goes by the name it gave itself.
  static func fromName(_ from: String?, start: Bool = true) -> String {
    isCoordinator(from) ? (start ? "Your agent" : "your agent") : (from ?? "")
  }

  static func capitalized(_ s: String) -> String {
    s.prefix(1).uppercased() + s.dropFirst()
  }

  // A sentence of the desk's own words: a capital first, and a full stop unless it ends itself.
  static func sentence(_ s: String) -> String {
    capitalized(s) + (s.last.map { ".?!".contains($0) } == true ? "" : ".")
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
    "merge": "Merge",
  ]

  static let sessionKind: [String: String] = ["cli": "CLI", "background": "Background", "desktop": "Desktop", "codex": "Codex"]
  static let sessionAction: [String: String] = [
    "kick": "Kick", "resume": "Resume in background", "attach": "Copy attach command", "open": "Open",
  ]

  static let verdict: [String: String] = ["look": "Look closely", "skim": "Skim it", "skip": "Skip it"]

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
            text: "Start it with `desk serve` or open the desktop app.", fix: .retry, fixLabel: "Retry")
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

// MARK: The lists

enum Lists {
  // What the Inbox counts: Urgent and Standard, an agent's question and a session that needs you; less rows on their way off.
  static func inboxCount(_ v: QueueView, leaving: Set<String> = []) -> Int {
    let cards = (v.inbox?.urgent ?? []) + (v.inbox?.standard ?? [])
    return cards.filter { !leaving.contains($0.id) }.count + v.inquiries.count
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

  // What a row in the Archive says after its ref: why it's there.
  static func archiveNote(_ c: Card) -> String { c.resolved ?? "done: back when someone else acts" }
  static func hiddenNote(_ c: Card) -> String { (c.why ?? "").isEmpty ? "hidden by your rules" : c.why! }
}
