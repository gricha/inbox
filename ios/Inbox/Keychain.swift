import Foundation
import Security

// The device's token, one per desk address, readable only on this device while it's unlocked; never in a backup.
enum Keychain {
  private static let service = "dev.inbox.ios.desk-token"

  private static func query(_ account: String) -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
  }

  @discardableResult
  static func save(_ token: String, for account: String) -> Bool {
    SecItemDelete(query(account) as CFDictionary)
    var add = query(account)
    add[kSecValueData] = Data(token.utf8)
    add[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  static func read(for account: String) -> String? {
    var find = query(account)
    find[kSecReturnData] = true
    find[kSecMatchLimit] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(find as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func delete(for account: String) {
    SecItemDelete(query(account) as CFDictionary)
  }
}
