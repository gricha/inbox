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
  var people: [String]?
  var stage: String?
  var bucket: String?
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
  var cta: String?  // "ready" | "reply" | "reviewers" | "merge"
  var resolved: String?
  var resolvedAt: String?
  var inflight: Bool?
  var stack: StackRef?
  var blocker: Blocker?
  var depth: Int?
  var reason: String?
  var quick: String?

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

  var isPR: Bool { kind == "pr" }
  var mine: Bool { by == "you" }
  var active: Bool { (status ?? "active") == "active" }
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
}

struct NotesView: Decodable, Sendable {
  @Lossy var due: [Note]
  @Lossy var open: [Note]
  @Lossy var later: [Note]
}

// MARK: Merging

struct InflightView: Decodable, Sendable {
  @Lossy var rows: [Row]
  var stacks: [String: Stack]?
  var coordinator: Coordinator?

  struct Row: Decodable, Identifiable, Sendable {
    let card: Card
    var state: String?  // "open" | "closed" | "merged"
    var waitsOn: String?
    var note: AgentNote?
    var id: String { card.id }
  }

  struct AgentNote: Decodable, Sendable {
    var text: String?
    var at: String?
  }

  struct Coordinator: Decodable, Sendable {
    var on: Bool?
    var id: String?
    var url: String?
    var error: String?
  }
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

  struct Item: Decodable, Sendable {
    var state: String?  // "open" | "closed" | "merged"
    var labels: [String]?
    var additions: Int?
    var deletions: Int?
    var commentsTotal: Int?
  }
}

struct AiReview: Decodable, Sendable {
  var verdict: String?  // "look" | "skim" | "skip"
  var risk: String?  // "low" | "medium" | "high"
  var summary: String?
  var since: String?
  var concerns: [String]?
  @Lossy var riskReasons: [RiskReason]

  struct RiskReason: Decodable, Sendable {
    var why: String?
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
