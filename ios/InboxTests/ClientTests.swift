import XCTest

@testable import Inbox

// The client against the desk's exact answers (docs/api.md, src/server.ts), stubbed: nothing here reaches a network.
final class ClientTests: XCTestCase {
  private let tailnet = DeskAddress(url: URL(string: "https://desk.tail1234.ts.net")!)
  private let local = DeskAddress(url: URL(string: "http://localhost:47823")!)
  private typealias Answer = StubProtocol.Answer

  private func client(_ address: DeskAddress? = nil, token: String? = "inbox_test") -> APIClient {
    APIClient(address: address ?? tailnet, token: token, session: StubProtocol.session())
  }

  private func refused(_ status: Int, _ words: String, tag: String = "Forbidden") -> Answer {
    Answer(status: status, body: #"{"error":"\#(words)","tag":"\#(tag)"}"#)
  }

  private func failure<T>(_ run: () async throws -> T) async -> APIError? {
    do {
      _ = try await run()
      return nil
    } catch { return error as? APIError }
  }

  // MARK: Pairing

  func testPairingTradesTheCodeOnce() async throws {
    StubProtocol.reset([
      "/api/pair": Answer(
        body: #"{"ok":true,"token":"inbox_abc","device":{"id":"0123456789abcdef","name":"iPhone","kind":"device","created_at":"2026-11-12T09:00:00.000Z","last_used_at":null}}"#)
    ])
    let answer = try await client(token: nil).pair(code: "ABCD2345", name: "iPhone")
    XCTAssertEqual(answer.token, "inbox_abc")
    XCTAssertEqual(answer.device?.name, "iPhone")
    let sent = StubProtocol.requests()
    XCTAssertEqual(sent.count, 1, "one try per press: any try burns the code")
    XCTAssertEqual(sent[0].httpMethod, "POST")
    XCTAssertEqual(sent[0].url?.absoluteString, "https://desk.tail1234.ts.net/api/pair")
    XCTAssertNil(sent[0].value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(sent[0].value(forHTTPHeaderField: "Origin"), "an Origin would be refused")
    let body = try JSONDecoder().decode([String: String].self, from: try XCTUnwrap(sent[0].sentBody))
    XCTAssertEqual(body, ["code": "ABCD2345", "name": "iPhone", "kind": "device"])
  }

  func testAWrongOrUsedCode() async {
    StubProtocol.reset(["/api/pair": refused(403, "that pairing code isn't valid: run desk pair again for a new one")])
    let e = await failure { try await self.client(token: nil).pair(code: "ABCD2345", name: "x") }
    XCTAssertEqual(e, .refused(status: 403, message: "that pairing code isn't valid: run desk pair again for a new one"))
    let why = PairFailure(e!, host: tailnet.host)
    XCTAssertEqual(why, .badCode("that pairing code isn't valid: run desk pair again for a new one"))
    XCTAssertEqual(why.words, "That pairing code isn't valid: run desk pair again for a new one.")
    XCTAssertEqual(StubProtocol.requests().count, 1, "never retried")
  }

  func testTooManyTries() async {
    StubProtocol.reset(["/api/pair": refused(429, "too many pairing attempts: wait a minute", tag: "TooManyRequests")])
    let e = await failure { try await self.client(token: nil).pair(code: "ABCD2345", name: "x") }
    XCTAssertEqual(PairFailure(e!, host: tailnet.host), .tooMany("too many pairing attempts: wait a minute"))
    XCTAssertEqual(StubProtocol.requests().count, 1)
  }

  // Tailscale says this phone is someone else's: not a bad token, and not a bad code.
  func testTheWrongTailscaleLogin() async {
    StubProtocol.reset(["/api/pair": refused(403, "only the desk's owner may use it from another device")])
    let e = await failure { try await self.client(token: nil).pair(code: "ABCD2345", name: "x") }
    let why = PairFailure(e!, host: tailnet.host)
    XCTAssertEqual(why, .wrongLogin("only the desk's owner may use it from another device"))
    XCTAssertTrue(why.words.hasPrefix("Only the desk's owner may use it from another device."))
    XCTAssertTrue(why.words.contains("Sign this phone in to Tailscale as the desk's owner"))
  }

  func testNotServedOverTailscale() async {
    StubProtocol.reset(["/api/pair": refused(403, "this desk isn't served over Tailscale now")])
    let e = await failure { try await self.client(token: nil).pair(code: "ABCD2345", name: "x") }
    let why = PairFailure(e!, host: tailnet.host)
    XCTAssertEqual(why, .notServed("this desk isn't served over Tailscale now"))
    XCTAssertTrue(why.words.contains("Use it from your other devices"))
  }

  func testAnAddressNothingAnswersAt() async {
    StubProtocol.reset(["/api/pair": Answer(error: .cannotFindHost)])
    let e = await failure { try await self.client(token: nil).pair(code: "ABCD2345", name: "x") }
    XCTAssertEqual(e, .unreachable)
    let why = PairFailure(e!, host: tailnet.host)
    XCTAssertEqual(why, .unreachable(host: "desk.tail1234.ts.net"))
    XCTAssertEqual(why.words, "Can't reach desk.tail1234.ts.net. Check Tailscale is on on this phone, and that the desk's computer is awake.")
    for code in [URLError.Code.timedOut, .notConnectedToInternet, .cannotConnectToHost, .secureConnectionFailed] {
      StubProtocol.reset(["/api/pair": Answer(error: code)])
      let e = await failure { try await self.client(token: nil).pair(code: "ABCD2345", name: "x") }
      XCTAssertEqual(e, .unreachable)
    }
  }

  func testAnyOtherRefusalKeepsTheDesksWords() async {
    StubProtocol.reset(["/api/pair": refused(403, "forbidden host")])
    let e = await failure { try await self.client(token: nil).pair(code: "ABCD2345", name: "x") }
    XCTAssertEqual(PairFailure(e!, host: tailnet.host).words, "Forbidden host.")
  }

  // MARK: Every later request

  func testABearerOnEveryRequestOverTailscaleAndNoneOnLocalhost() async throws {
    StubProtocol.reset(["/health": Answer(body: #"{"ok":true,"version":"0.2.7"}"#)])
    let version = try await client().health().version
    XCTAssertEqual(version, "0.2.7")
    XCTAssertEqual(StubProtocol.requests()[0].value(forHTTPHeaderField: "Authorization"), "Bearer inbox_test")
    _ = try await client(local).health()
    XCTAssertNil(StubProtocol.requests()[1].value(forHTTPHeaderField: "Authorization"), "the desk's own computer needs no token")
    XCTAssertEqual(StubProtocol.requests()[1].url?.absoluteString, "http://localhost:47823/health")
  }

  // 401: the device was revoked.
  func testRevoked() async {
    StubProtocol.reset(["/api/queue": refused(401, "pair this device first: run desk pair on the desk's machine", tag: "Unauthorized")])
    let e = await failure { try await self.client().queue() }
    XCTAssertEqual(e, .unpaired("pair this device first: run desk pair on the desk's machine"))
  }

  // Whatever isn't the desk's JSON means the desk isn't there: Tailscale's own page, a proxy's 502, the web UI's HTML.
  func testAnswersThatAreNotTheDesks() async {
    StubProtocol.reset(["/api/queue": Answer(status: 502, type: "text/html", body: "<html>Bad Gateway</html>")])
    var e = await failure { try await self.client().queue() }
    XCTAssertEqual(e, .notDesk)
    StubProtocol.reset(["/api/queue": Answer(status: 200, type: "text/html; charset=utf-8", body: "<!doctype html>")])
    e = await failure { try await self.client().queue() }
    XCTAssertEqual(e, .notDesk, "an unknown path answers the window's HTML with 200")
    StubProtocol.reset(["/api/queue": Answer(status: 200, body: "[1, 2")])
    e = await failure { try await self.client().queue() }
    XCTAssertEqual(e, .refused(status: 200, message: "This app can't read the desk's answer: is the desk newer than the app?"))
  }

  func testStartingAndBrokenRules() async {
    StubProtocol.reset([
      "/api/queue": Answer(status: 503, body: #"{"error":"desk is starting; the first sync can take a minute","tag":"Unavailable","reason":"starting"}"#)
    ])
    var e = await failure { try await self.client().queue() }
    XCTAssertEqual(e, .starting("desk is starting; the first sync can take a minute"))
    StubProtocol.reset(["/api/queue": Answer(status: 503, body: #"{"error":"config has errors: a: b","tag":"Unavailable","reason":"config"}"#)])
    e = await failure { try await self.client().queue() }
    XCTAssertEqual(e, .rules("config has errors: a: b"))
    // An older desk may leave the tag out: the status still says what it is.
    StubProtocol.reset(["/api/queue": Answer(status: 409, body: #"{"error":"acme/api#1 is in Merging, so your agent has it; bring it back to the desk first"}"#)])
    e = await failure { try await self.client().queue() }
    XCTAssertEqual(e, .refused(status: 409, message: "acme/api#1 is in Merging, so your agent has it; bring it back to the desk first"))
  }

  // MARK: What it asks, and how

  func testAnItemsIdIsEncodedInTheQuery() async throws {
    StubProtocol.reset(["/api/item": Answer(body: String(decoding: try Fixture.data("item"), as: UTF8.self))])
    let detail = try await client().item("acme/api#4127")
    XCTAssertEqual(detail.card.id, "acme/api#4127")
    XCTAssertEqual(StubProtocol.requests()[0].url?.absoluteString, "https://desk.tail1234.ts.net/api/item?id=acme%2Fapi%234127")
  }

  func testActSendsTheActionAndReadsItsUndo() async throws {
    StubProtocol.reset(["/api/act": Answer(body: #"{"ok":true,"state":{"id":"acme/api#4127"},"undo_seq":41}"#)])
    let answer = try await client().act("acme/api#4127", "snooze", until: "tomorrow")
    XCTAssertEqual(answer.undoSeq, 41)
    let sent = StubProtocol.requests()[0]
    XCTAssertEqual(sent.httpMethod, "POST")
    XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/json")
    let body = try JSONDecoder().decode([String: String].self, from: try XCTUnwrap(sent.sentBody))
    XCTAssertEqual(body, ["id": "acme/api#4127", "action": "snooze", "until": "tomorrow"])
  }

  func testUndoSendsItsSeqAsANumber() async throws {
    StubProtocol.reset(["/api/undo": Answer(body: #"{"ok":true,"id":"acme/api#4127","action":"done"}"#)])
    let answer = try await client().undo(seq: 41)
    XCTAssertEqual(answer.action, "done")
    let body = try JSONDecoder().decode([String: Int].self, from: try XCTUnwrap(StubProtocol.requests()[0].sentBody))
    XCTAssertEqual(body, ["seq": 41])
  }

  func testAQuestionIsOnlyRead() async throws {
    StubProtocol.reset(["/api/inquiries/q1c0ffee": Answer(body: String(decoding: try Fixture.data("inquiry"), as: UTF8.self))])
    let q = try await client().inquiry("q1c0ffee")
    XCTAssertEqual(q.options.count, 3)
    XCTAssertEqual(StubProtocol.requests().map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }, ["GET /api/inquiries/q1c0ffee"])
  }

  // The stream never asks for the desk's notifications: ?notify=1 would take them away from its computer.
  func testTheEventStreamsRequest() {
    let req = client().request("GET", "/api/events")
    XCTAssertEqual(req.url?.absoluteString, "https://desk.tail1234.ts.net/api/events")
    XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer inbox_test")
  }
}

// The store's part: where a failed request leaves the app.
@MainActor
final class StoreTests: XCTestCase {
  private var defaults: UserDefaults!
  private let suite = "dev.inbox.ios.tests.\(UUID().uuidString)"
  private let address = "https://desk.tail1234.ts.net"

  override func setUp() async throws {
    defaults = UserDefaults(suiteName: suite)
  }

  override func tearDown() async throws {
    defaults.removePersistentDomain(forName: suite)
    Keychain.delete(for: address)
  }

  private let pair = StubProtocol.Answer(body: #"{"ok":true,"token":"inbox_abc","device":{"id":"0123456789abcdef","name":"Greg's iPhone","kind":"device"}}"#)

  func testPairingKeepsTheTokenInTheKeychainAndTheAddressInDefaults() async throws {
    StubProtocol.reset(["/api/pair": pair])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    XCTAssertNil(store.address)
    let said = await store.connect(typed: "desk.tail1234.ts.net/pair#abcd-2345", code: "")
    store.stopLive()
    XCTAssertNil(said)
    XCTAssertEqual(store.address?.text, address)
    XCTAssertEqual(store.deviceName, "Greg's iPhone")
    XCTAssertEqual(Keychain.read(for: address), "inbox_abc")
    XCTAssertEqual(defaults.string(forKey: "desk.address"), address)
    XCTAssertFalse(defaults.dictionaryRepresentation().values.contains { ($0 as? String)?.contains("inbox_abc") == true }, "the token is never in UserDefaults")
    // The next launch finds both.
    let again = Store(defaults: defaults, session: StubProtocol.session())
    XCTAssertEqual(again.address?.text, address)
    XCTAssertEqual(again.deviceName, "Greg's iPhone")
  }

  // A code typed before (and already tried) never rides along with a pasted link: the link's own code is the one traded.
  func testAPairingLinksCodeWinsOverOneTypedBefore() async throws {
    StubProtocol.reset(["/api/pair": pair])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    var said = await store.connect(typed: "https://desk.tail1234.ts.net/pair#WXYZ-6789", code: "ABCD-2345")
    store.stopLive()
    XCTAssertNil(said)
    let sent = StubProtocol.requests().filter { $0.url?.path == "/api/pair" }
    XCTAssertEqual(sent.count, 1)
    let body = try JSONDecoder().decode([String: String].self, from: try XCTUnwrap(sent[0].sentBody))
    XCTAssertEqual(body["code"], "WXYZ6789")
    // Nor does a leftover that isn't a code's shape stop the link.
    store.disconnect()
    StubProtocol.reset(["/api/pair": pair])
    said = await store.connect(typed: "desk.tail1234.ts.net/pair#wxyz-6789", code: "ABC")
    store.stopLive()
    XCTAssertNil(said)
  }

  func testACodeThatCannotBeOneIsNeverSent() async {
    StubProtocol.reset(["/api/pair": pair])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    let said = await store.connect(typed: address, code: "ABC-123")
    XCTAssertEqual(said?.hasPrefix("A pairing code is 8 letters and digits"), true)
    XCTAssertTrue(StubProtocol.requests().isEmpty, "a slip of the thumb spends no try")
    XCTAssertNil(store.address)
  }

  func testARefusedPairingSaysWhyAndSavesNothing() async {
    StubProtocol.reset(["/api/pair": .init(status: 403, body: #"{"error":"that pairing code isn't valid: run desk pair again for a new one","tag":"Forbidden"}"#)])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    let said = await store.connect(typed: address, code: "ABCD-2345")
    XCTAssertEqual(said, "That pairing code isn't valid: run desk pair again for a new one.")
    XCTAssertNil(store.address)
    XCTAssertNil(Keychain.read(for: address))
    XCTAssertNil(defaults.string(forKey: "desk.address"))
    XCTAssertEqual(StubProtocol.requests().count, 1)
  }

  func testLocalhostConnectsWithNoCodeAndNoToken() async {
    StubProtocol.reset(["/health": .init(body: #"{"ok":true,"version":"0.2.7"}"#)])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    let said = await store.connect(typed: "localhost:47823", code: "")
    store.stopLive()
    XCTAssertNil(said)
    XCTAssertEqual(store.address?.text, "http://localhost:47823")
    XCTAssertFalse(StubProtocol.requests().contains { $0.url?.path == "/api/pair" }, "the desk's own computer never pairs")
    XCTAssertNil(Keychain.read(for: "http://localhost:47823"))
  }

  func testNothingAtALocalAddress() async {
    StubProtocol.reset([:])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    let said = await store.connect(typed: "http://localhost:9", code: "")
    XCTAssertEqual(said, "Nothing answers at http://localhost:9. Start the desk with desk serve, or open the desktop app.")
    XCTAssertNil(store.address)
  }

  // A 401 later: the device was revoked. Back to the connect screen, saying so, the token forgotten and the address kept.
  func testRevokedGoesBackToPairing() async {
    StubProtocol.reset(["/api/pair": pair])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    _ = await store.connect(typed: address, code: "ABCD-2345")
    store.stopLive()
    let unpaired = StubProtocol.Answer(status: 401, body: #"{"error":"pair this device first: run desk pair on the desk's machine","tag":"Unauthorized"}"#)
    StubProtocol.reset(["/api/overview": unpaired, "/api/queue": unpaired])
    await store.load()
    XCTAssertNil(store.address)
    XCTAssertEqual(store.connectNote?.contains("revoked on the desk's computer"), true)
    XCTAssertEqual(store.lastAddress, address)
    XCTAssertNil(Keychain.read(for: address))
  }

  // The desk away: its bubble, in the words for where it is, and what was on screen stays.
  func testOfflineAndBack() async throws {
    StubProtocol.reset(["/api/pair": pair])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    _ = await store.connect(typed: address, code: "ABCD-2345")
    store.stopLive()
    let ok = { (name: String) in StubProtocol.Answer(body: String(decoding: try Fixture.data(name), as: UTF8.self)) }
    StubProtocol.reset(["/api/overview": try ok("overview"), "/api/queue": try ok("queue")])
    await store.load()
    XCTAssertEqual(store.inboxCount, 29)
    XCTAssertTrue(store.notices.isEmpty, "nothing is said while all is well")

    StubProtocol.reset(["/api/overview": .init(status: 502, type: "text/html", body: "Bad Gateway"), "/api/queue": .init(error: .timedOut)])
    await store.load()
    XCTAssertTrue(store.offline)
    XCTAssertEqual(store.notices.map(\.title), ["The desk can't be reached"])
    XCTAssertEqual(store.inboxCount, 29, "the last answer stays on screen")

    StubProtocol.reset(["/api/overview": try ok("overview"), "/api/queue": try ok("queue")])
    await store.load()
    XCTAssertFalse(store.offline)
    XCTAssertTrue(store.notices.isEmpty)
  }

  func testDisconnectForgetsTheTokenAndTheAddress() async {
    StubProtocol.reset(["/api/pair": pair])
    let store = Store(defaults: defaults, session: StubProtocol.session())
    _ = await store.connect(typed: address, code: "ABCD-2345")
    store.disconnect()
    XCTAssertNil(store.address)
    XCTAssertNil(store.connectNote)
    XCTAssertNil(Keychain.read(for: address))
    XCTAssertNil(defaults.string(forKey: "desk.address"))
    XCTAssertFalse(StubProtocol.requests().contains { $0.httpMethod == "DELETE" }, "the phone can't revoke itself, and doesn't try")
  }
}
