import Foundation

// What a request to the desk can come to. The desk's own words travel in `message`, shown verbatim.
enum APIError: Error, Equatable {
  case unreachable  // no answer at all: Tailscale off, the computer asleep, nothing listening
  case notDesk  // something answered, but not the desk's JSON (Tailscale's own page, a proxy's 502 while it restarts)
  case unpaired(String)  // 401: this device isn't paired any more
  case starting(String)  // 503: no first sync yet
  case rules(String)  // 503: the desk's rules don't load
  case refused(status: Int, message: String)

  var words: String {
    switch self {
    case .unreachable: "Can't reach the desk."
    case .notDesk: "The desk didn't answer: something else did at its address."
    case .unpaired(let m), .starting(let m), .rules(let m), .refused(_, let m): m
    }
  }
}

// Why pairing failed, each case told apart: what the desk said, and what to do about it from here.
enum PairFailure: Error, Equatable {
  case badCode(String)  // wrong, expired or used: the try burned it
  case tooMany(String)
  case wrongLogin(String)  // this phone's Tailscale login isn't the desk's owner's
  case notServed(String)  // the desk isn't served over Tailscale now
  case unreachable(host: String)
  case other(String)

  init(_ error: APIError, host: String) {
    switch error {
    case .unreachable, .notDesk: self = .unreachable(host: host)
    case .refused(429, let m): self = .tooMany(m)
    case .refused(403, let m) where m.contains("pairing code"): self = .badCode(m)
    case .refused(403, let m) where m.contains("desk's owner"): self = .wrongLogin(m)
    case .refused(403, let m) where m.contains("served over Tailscale"): self = .notServed(m)
    default: self = .other(error.words)
    }
  }

  // The desk's own words first, then the way out where there is one.
  var words: String {
    switch self {
    case .badCode(let m), .tooMany(let m), .other(let m): Words.capitalized(m) + "."
    case .wrongLogin(let m): Words.capitalized(m) + ". Sign this phone in to Tailscale as the desk's owner."
    case .notServed(let m):
      Words.capitalized(m) + ". Turn on Settings → This device → Use it from your other devices on the desk's computer."
    case .unreachable(let host): "Can't reach \(host). Check this phone has Tailscale on, and that the desk's computer is awake."
    }
  }
}

// One client for the desk's HTTP API. Over Tailscale it sends the device's token; on localhost nothing.
// It calls only what a paired device may: reads, POST /api/act, /api/undo and /api/sync, and /api/pair once.
struct APIClient: Sendable {
  let address: DeskAddress
  var token: String?
  var session: URLSession = APIClient.plain

  static let plain: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 20
    c.waitsForConnectivity = false
    return URLSession(configuration: c)
  }()

  // A path under the desk's address. A query value keeps only unreserved characters, so an id's "/" and "#" are encoded.
  func request(_ method: String, _ path: String, query: [String: String] = [:], body: [String: String]? = nil) -> URLRequest {
    var parts = URLComponents(url: address.url, resolvingAgainstBaseURL: false) ?? URLComponents()
    parts.percentEncodedPath = path
    let strict = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    if !query.isEmpty {
      parts.percentEncodedQuery = query.sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: strict) ?? "")" }
        .joined(separator: "&")
    }
    var req = URLRequest(url: parts.url ?? address.url)
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token, !address.isLocal { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONEncoder().encode(body)
    }
    return req
  }

  func send<T: Decodable>(_ req: URLRequest, as _: T.Type = T.self) async throws -> T {
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: req)
    } catch let e as URLError where e.code == .cancelled {
      throw CancellationError()
    } catch is URLError {
      throw APIError.unreachable
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.notDesk }
    // The desk always answers JSON; anything else is whatever stands in for it while it's away.
    guard (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().contains("json") else { throw APIError.notDesk }
    let decoder = DeskJSON.decoder()
    if (200..<300).contains(http.statusCode) {
      do { return try decoder.decode(T.self, from: data) } catch {
        throw APIError.refused(status: http.statusCode, message: "This app can't read the desk's answer: is the desk newer than the app?")
      }
    }
    let said = try? decoder.decode(ErrorBody.self, from: data)
    let message = said?.error ?? "the desk answered \(http.statusCode)"
    switch http.statusCode {
    case 401: throw APIError.unpaired(message)
    case 503: throw said?.reason == "config" ? APIError.rules(message) : APIError.starting(message)
    default: throw APIError.refused(status: http.statusCode, message: message)
    }
  }

  func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
    try await send(request("GET", path, query: query))
  }

  func post<T: Decodable>(_ path: String, _ body: [String: String] = [:]) async throws -> T {
    try await send(request("POST", path, body: body))
  }

  // MARK: What the phone asks

  func health() async throws -> Health { try await get("/health") }
  func overview() async throws -> Overview { try await get("/api/overview") }
  func queue() async throws -> QueueView { try await get("/api/queue") }
  func inflight() async throws -> InflightView { try await get("/api/inflight") }
  func item(_ id: String) async throws -> ItemDetail { try await get("/api/item", query: ["id": id]) }

  func inquiry(_ id: String) async throws -> Inquiry {
    let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? id
    return try await get("/api/inquiries/\(safe)")
  }

  // done, snooze (with `until`), mute, unmute, restore, seen: all a paired device may do to an item.
  func act(_ id: String, _ action: String, until: String? = nil) async throws -> ActAnswer {
    var body = ["id": id, "action": action]
    if let until { body["until"] = until }
    return try await post("/api/act", body)
  }

  func undo(seq: Int) async throws -> UndoAnswer {
    var req = request("POST", "/api/undo")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONEncoder().encode(["seq": seq])
    return try await send(req)
  }

  func sync() async throws {
    let _: Ok = try await post("/api/sync")
  }

  // Trades the pairing code for this device's token. Called once per press: any try burns the code, right or wrong.
  func pair(code: String, name: String) async throws -> PairAnswer {
    try await post("/api/pair", ["code": code, "name": name, "kind": "device"])
  }

  // The desk's event stream: one value per `update`, the cue to refetch. Never with ?notify=1, which would take the
  // desk's own notifications away from its computer. Silent for a minute (its pings come every 25 s), it ends.
  func events() -> AsyncThrowingStream<Void, Error> {
    var stream = request("GET", "/api/events")
    stream.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    stream.timeoutInterval = 60
    let req = stream
    let session = session
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let (bytes, response) = try await session.bytes(for: req)
          let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
          guard (response as? HTTPURLResponse)?.statusCode == 200, type.contains("event-stream") else { throw APIError.notDesk }
          for try await line in bytes.lines where line.hasPrefix("event:") && line.dropFirst(6).trimmingCharacters(in: .whitespaces) == "update" {
            continuation.yield()
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
