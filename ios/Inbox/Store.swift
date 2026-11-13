import Foundation
import Observation
import SwiftUI
import UIKit

enum Page: String, CaseIterable, Sendable {
  case inbox, blocked, merging, archive

  var name: String {
    switch self {
    case .inbox: "Inbox"
    case .blocked: "Blocked"
    case .merging: "Merging"
    case .archive: "Archive"
    }
  }
}

enum Route: Hashable, Sendable {
  case item(String)
  case inquiry(String)
  case session(String)
}

struct Toast: Equatable {
  let id = UUID()
  let text: String
  var undo: Int?  // the action's undo_seq, while Undo is offered
}

// Everything the views draw from: which desk, what it last said, and what you just did. The desk decides what's on each
// list and in what order; this only keeps the last answer (in memory: nothing is cached on disk) and renders it.
@MainActor
@Observable
final class Store {
  // The desk this phone is connected to; nil shows the connect screen.
  private(set) var address: DeskAddress?
  private(set) var deviceName: String?
  var connectNote: String?  // why the connect screen is back (the device was revoked)

  var page: Page = .inbox
  var path: [Route] = []
  var showSettings = false
  var snoozing: Card?  // the row whose Snooze was swiped: its options are asked for

  private(set) var overview: Overview?
  private(set) var queue: QueueView?
  private(set) var inflight: InflightView?
  private(set) var loads = 0  // bumped on every answer from the desk: an opened item refetches
  private(set) var offline = false
  private(set) var starting: String?
  private(set) var broken: String?
  private(set) var refused: String?  // the desk's words for a read it wouldn't give (another Tailscale login, a desk this app can't read)
  private(set) var leaving: Set<String> = []
  private(set) var toast: Toast?
  private(set) var failures: [Notice] = []
  private(set) var deskVersion: String?
  var dismissed: [String: String] = [:]
  var folded: Set<String> = ["cleared", "hidden"]  // the Archive's two quiet groups start closed
  var now = Date()

  @ObservationIgnored private var client: APIClient?
  @ObservationIgnored private var live: Task<Void, Never>?
  @ObservationIgnored private var pending: Task<Void, Never>?
  @ObservationIgnored private var toastTimer: Task<Void, Never>?
  @ObservationIgnored private var session: URLSession
  @ObservationIgnored var debugEmpty = false  // DEBUG shots: draw the desk as if nothing were on it
  @ObservationIgnored private let defaults: UserDefaults

  private static let addressKey = "desk.address"
  private static let deviceKey = "desk.device"

  init(defaults: UserDefaults = .standard, session: URLSession = APIClient.plain) {
    self.defaults = defaults
    self.session = session
    if let saved = defaults.string(forKey: Store.addressKey), case .success(let parsed) = DeskAddress.parse(saved) {
      let token = Keychain.read(for: parsed.address.text)
      // A tailnet address without its token can't ask anything: back to pairing.
      if parsed.address.isLocal || token != nil {
        address = parsed.address
        deviceName = defaults.string(forKey: Store.deviceKey)
        client = APIClient(address: parsed.address, token: token, session: session)
      }
    }
  }

  var agent: String { overview?.aiAgent ?? "Claude" }
  var me: String { overview?.me ?? "" }
  var inboxCount: Int { queue.map { Lists.inboxCount($0, leaving: leaving) } ?? 0 }

  // MARK: Connecting

  // Returns the words to show when it didn't work. A code is traded once per press, never retried here.
  func connect(typed: String, code typedCode: String) async -> String? {
    let parsed: (address: DeskAddress, code: String?)
    switch DeskAddress.parse(typed) {
    case .failure(let why): return why.words
    case .success(let p): parsed = p
    }
    let address = parsed.address
    var fresh = APIClient(address: address, token: nil, session: session)
    var device: String?
    do {
      if address.isLocal {
        // The desk's own computer: no code, no token. Just see that a desk answers.
        deskVersion = try await fresh.health().version
      } else {
        // A pasted pairing link's code wins: whatever was typed before it is a code already tried, and any try burns the new one.
        guard let code = parsed.code ?? PairingCode.normalize(typedCode) else {
          return "A pairing code is 8 letters and digits, like ABCD-2345: desk pair prints one on the desk's computer."
        }
        let answer = try await fresh.pair(code: code, name: UIDevice.current.name)
        guard let token = answer.token, !token.isEmpty else { return "The desk paired this device but sent no token." }
        guard Keychain.save(token, for: address.text) else { return "Couldn't keep the token in this phone's Keychain." }
        fresh.token = token
        device = answer.device?.name
      }
    } catch let e as APIError {
      return address.isLocal ? Store.localWords(e, address) : PairFailure(e, host: address.host).words
    } catch {
      return nil  // cancelled
    }
    defaults.set(address.text, forKey: Store.addressKey)
    defaults.set(device, forKey: Store.deviceKey)
    adopt(address, device: device, client: fresh)
    return nil
  }

  private static func localWords(_ e: APIError, _ address: DeskAddress) -> String {
    switch e {
    case .unreachable: "Nothing answers at \(address.text). Start the desk with desk serve, or open the desktop app."
    case .notDesk: "Something answers at \(address.text), but it isn't the desk."
    default: Words.capitalized(e.words) + "."
    }
  }

  private func adopt(_ address: DeskAddress, device: String?, client: APIClient) {
    self.address = address
    deviceName = device
    self.client = client
    connectNote = nil
    reset()
    startLive()
  }

  private func reset() {
    overview = nil
    queue = nil
    inflight = nil
    offline = false
    starting = nil
    broken = nil
    refused = nil
    leaving = []
    toast = nil
    failures = []
    dismissed = [:]
    path = []
    page = .inbox
    showSettings = false
  }

  // Forgets the token on this phone. The device stays listed on the desk until its owner revokes it there.
  func disconnect(note: String? = nil) {
    stopLive()
    if let address { Keychain.delete(for: address.text) }
    defaults.removeObject(forKey: Store.deviceKey)
    if note == nil { defaults.removeObject(forKey: Store.addressKey) }
    lastAddress = note == nil ? "" : (address?.text ?? "")
    address = nil
    client = nil
    deviceName = nil
    reset()
    connectNote = note
  }

  private(set) var lastAddress = ""  // the connect screen's address, after a revoke

  // MARK: Loading

  func load() async {
    guard let client else { return }
    do {
      async let o = client.overview()
      async let q = client.queue()
      let (ov, qv) = try await (o, q)
      overview = ov
      queue = debugEmpty ? QueueView() : qv
      if page == .merging || inflight != nil { inflight = try await client.inflight() }
      offline = false
      starting = nil
      broken = nil
      refused = nil
      loads += 1
    } catch let e as APIError {
      took(e)
    } catch {}
  }

  // What a failed read means for the page: only an answer the desk itself gave is shown as its words.
  private func took(_ e: APIError, action: Bool = false) {
    switch e {
    case .unreachable, .notDesk:
      offline = true
      starting = nil
      refused = nil
    case .unpaired:
      disconnect(note: "This phone isn't paired with the desk any more: it was revoked on the desk's computer. Pair it again.")
    case .starting(let m):
      offline = false
      starting = m
      refused = nil
    case .rules(let m):
      offline = false
      starting = nil
      refused = nil
      broken = m
    case .refused(_, let m):
      offline = false
      starting = nil
      // An action's refusal fades; a read's stays until the desk answers one.
      if action { fail(m) } else { refused = m }
    }
  }

  func openMerging() async {
    guard let client, inflight == nil else { return }
    do { inflight = try await client.inflight() } catch let e as APIError { took(e) } catch {}
  }

  // Pull to refresh: asks the desk to sync now, then reads what it has. The sync's own result arrives as an update.
  func refresh() async {
    guard let client else { return }
    // A sync nothing answered already says the desk is away: no second wait for the read to say it again.
    do { try await client.sync() } catch let e as APIError {
      if e == .unreachable || e == .notDesk { return took(e) }
    } catch {}
    await load()
  }

  func retry() {
    Task { await load() }
  }

  func syncNow() {
    Task { await refresh() }
  }

  // MARK: Live

  // The desk's event stream while the app is in front: every update refetches, debounced as the window's (they come in
  // bursts during a sync). A stream that ends or never opens reads once and tries again, a little later each time.
  func startLive() {
    stopLive()
    guard let client else { return }
    live = Task { [weak self] in
      if Task.isCancelled { return }
      // Read first: a desk that doesn't answer (its computer asleep) holds the stream's request for a minute before it fails.
      await self?.load()
      var wait = 1.0
      while !Task.isCancelled {
        do {
          for try await _ in client.events() {
            wait = 1
            self?.loadSoon()
          }
        } catch {}
        if Task.isCancelled { return }
        await self?.load()
        try? await Task.sleep(for: .seconds(wait))
        wait = min(wait * 2, 15)
      }
    }
  }

  func stopLive() {
    live?.cancel()
    live = nil
    pending?.cancel()
    pending = nil
  }

  private func loadSoon() {
    pending?.cancel()
    pending = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(300))
      if Task.isCancelled { return }
      await self?.load()
    }
  }

  // MARK: Acting

  // done, snooze, mute, unmute, restore: what a paired device may do. The row leaves at once, and comes back if the desk refuses.
  func act(_ id: String, name: String, _ action: String, snooze: SnoozeOption? = nil) {
    guard let client else { return }
    let leaves = ["done", "snooze", "mute"].contains(action)
    if leaves { withAnimation(.easeOut(duration: 0.2)) { _ = leaving.insert(id) } }
    Task {
      do {
        let answer = try await client.act(id, action, until: snooze?.until)
        let verbs = ["done": "Done", "mute": "Muted", "unmute": "Unmuted", "restore": "Restored"]
        let verb = snooze.map { "Snoozed \($0.toast)" } ?? verbs[action] ?? Words.capitalized(action)
        flash("\(verb): \(name)", undo: (answer.undoSeq ?? 0) > 0 ? answer.undoSeq : nil)
        await load()
      } catch let e as APIError {
        took(e, action: true)
      } catch {}
      leaving.remove(id)
    }
  }

  // Opening an item is seeing it: the desk clears its "new". Nothing to show, nothing to undo.
  func seen(_ card: Card) {
    guard let client, card.new == true else { return }
    Task { _ = try? await client.act(card.id, "seen") }
  }

  func undo() {
    guard let client, let seq = toast?.undo else { return }
    toast = nil
    Task {
      do {
        let r = try await client.undo(seq: seq)
        let short = (r.id ?? "").replacingOccurrences(of: #"^[^/]+/"#, with: "", options: .regularExpression)
        flash("Undid \(r.action ?? "that") on \(short)")
        await load()
      } catch let e as APIError {
        took(e, action: true)
      } catch {}
    }
  }

  func flash(_ text: String, undo: Int? = nil) {
    toastTimer?.cancel()
    toast = Toast(text: text, undo: undo)
    toastTimer = Task { [weak self] in
      try? await Task.sleep(for: .seconds(6))
      if !Task.isCancelled { self?.toast = nil }
    }
  }

  // An action that failed: a bubble in the desk's own words, at most three, each fading on its own.
  private func fail(_ text: String) {
    let notice = Notice(id: "failed:\(Date().timeIntervalSince1970)", sig: text, tone: .red, title: text, transient: true)
    failures = Array((failures.filter { $0.title != text } + [notice]).suffix(3))
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(8))
      self?.failures.removeAll { $0.id == notice.id }
    }
  }

  func dismiss(_ n: Notice) {
    if n.transient { failures.removeAll { $0.id == n.id } } else { dismissed[n.id] = n.sig }
  }

  var notices: [Notice] {
    guard address != nil else { return [] }
    let all = Notices.of(
      Conditions(
        offline: offline, local: address?.isLocal ?? false, starting: starting, refused: refused, broken: broken, overview: overview,
        paused: queue?.paused, agent: agent), now: now)
    return all.filter { dismissed[$0.id] != $0.sig } + failures
  }

  // MARK: Finding what's on screen

  func card(_ id: String) -> Card? {
    guard let q = queue else { return inflight?.rows.first { $0.card.id == id }?.card }
    let lists = [q.inbox?.urgent, q.inbox?.standard, q.inbox?.fyi, q.sections?.blocked, q.cleared, q.resolved, q.hidden]
    return lists.compactMap { $0?.first { $0.id == id } }.first ?? inflight?.rows.first { $0.card.id == id }?.card
  }

  func merging(_ id: String) -> InflightView.Row? { inflight?.rows.first { $0.card.id == id } }

  func fetchItem(_ id: String) async -> Result<ItemDetail, APIError>? {
    guard let client else { return nil }
    do { return .success(try await client.item(id)) } catch let e as APIError {
      if case .unpaired = e { took(e) }
      return .failure(e)
    } catch { return nil }
  }

  func fetchInquiry(_ id: String) async -> Result<Inquiry, APIError>? {
    guard let client else { return nil }
    do { return .success(try await client.inquiry(id)) } catch let e as APIError {
      if case .unpaired = e { took(e) }
      return .failure(e)
    } catch { return nil }
  }

  #if DEBUG
    // Launch arguments for ios/shots.sh and for trying a state by hand; none of them is saved, and none is read in a release build.
    //   -deskURL http://localhost:47841   use this desk (localhost only), without touching the saved one
    //   -connect [-connectError "<words>"] [-connectAddress <text>]   the connect screen
    //   -page inbox|blocked|merging|archive   -open <item id>|inquiry:<id>|session:<id>   -settings   -empty
    func applyLaunchArguments(_ args: UserDefaults = .standard, flags: [String] = ProcessInfo.processInfo.arguments) {
      guard flags.contains(where: { ["-deskURL", "-connect"].contains($0) }) else { return }
      stopLive()
      address = nil
      client = nil
      connectNote = args.string(forKey: "connectError")
      lastAddress = args.string(forKey: "connectAddress") ?? ""
      guard !flags.contains("-connect"), let typed = args.string(forKey: "deskURL"), case .success(let parsed) = DeskAddress.parse(typed),
        parsed.address.isLocal
      else { return }
      address = parsed.address
      client = APIClient(address: parsed.address, token: nil, session: session)
      debugEmpty = flags.contains("-empty")
      page = Page(rawValue: args.string(forKey: "page") ?? "") ?? .inbox
      if let open = args.string(forKey: "open") {
        if open.hasPrefix("inquiry:") { path = [.inquiry(String(open.dropFirst(8)))] }
        else if open.hasPrefix("session:") { path = [.session(open)] }
        else { path = [.item(open)] }
      }
      showSettings = flags.contains("-settings")
      scrollTo = args.string(forKey: "scrollTo")
    }

    var scrollTo: String?
  #endif
}
