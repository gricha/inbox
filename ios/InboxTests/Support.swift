import Foundation
import XCTest

@testable import Inbox

enum Fixture {
  // A response saved from the mock desk (web/mock/server.ts), as InboxTests/Fixtures has it.
  static func data(_ name: String) throws -> Data {
    let url = try XCTUnwrap(Bundle(for: StubProtocol.self).url(forResource: name, withExtension: "json"), "no fixture \(name).json")
    return try Data(contentsOf: url)
  }

  static func decode<T: Decodable>(_ name: String, as _: T.Type = T.self) throws -> T {
    try DeskJSON.decoder().decode(T.self, from: try data(name))
  }
}

// Answers every request of a session from a table, so no test touches the network.
final class StubProtocol: URLProtocol {
  struct Answer {
    var status = 200
    var type = "application/json"
    var body = "{}"
    var error: URLError.Code?
    var hangs = false  // never answers, as a computer asleep on the tailnet
  }

  nonisolated(unsafe) static var answers: [String: Answer] = [:]  // by path
  nonisolated(unsafe) static var seen: [URLRequest] = []
  private static let lock = NSLock()

  static func reset(_ answers: [String: Answer]) {
    lock.withLock {
      self.answers = answers
      seen = []
    }
  }

  static func session() -> URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [StubProtocol.self]
    return URLSession(configuration: c)
  }

  static func requests() -> [URLRequest] { lock.withLock { seen } }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    let answer = StubProtocol.lock.withLock {
      StubProtocol.seen.append(request)
      return StubProtocol.answers[request.url?.path ?? ""]
    }
    if answer?.hangs == true { return }
    guard let answer, answer.error == nil, let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(answer?.error ?? .cannotConnectToHost))
      return
    }
    let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": answer.type])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}

extension URLRequest {
  // A stubbed session hands the body over as a stream.
  var sentBody: Data? {
    if let httpBody { return httpBody }
    guard let stream = httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var out = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let n = stream.read(&buffer, maxLength: buffer.count)
      if n <= 0 { break }
      out.append(buffer, count: n)
    }
    return out
  }
}
