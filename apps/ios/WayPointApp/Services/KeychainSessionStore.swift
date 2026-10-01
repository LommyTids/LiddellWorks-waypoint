import Foundation
import Security
import WayPointCore

struct SavedSession: Codable, Equatable, Sendable {
    let account: Account
    let cookieValue: String
    let expiresAt: Date

    /// This is only a local expiry/shape check. Only the server can verify the
    /// signature and current account permissions; never trust these claims as grants.
    func validate(at now: Date = Date()) throws {
        let claims = try Self.claims(from: cookieValue)
        guard !account.id.isEmpty, !account.username.isEmpty,
              claims.uid == account.id,
              expiresAt.timeIntervalSince1970.isFinite,
              expiresAt > now, claims.expiry > now,
              expiresAt <= claims.expiry else {
            throw APIError.unauthorized
        }
    }

    static func claims(from value: String) throws -> SessionClaims {
        // Restricts the Cookie header to the signed base64url token emitted by
        // the worker; semicolons, line breaks, and cookie injection are rejected.
        guard value.utf8.count <= 4096,
              let tokenRange = value.range(of: #"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$"#,
                                           options: .regularExpression),
              tokenRange == (value.startIndex..<value.endIndex) else {
            throw APIError.unauthorized
        }
        let pieces = value.split(separator: ".")
        var payload = String(pieces[0]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONDecoder().decode(SessionClaims.self, from: data),
              !claims.uid.isEmpty, claims.exp.isFinite, claims.exp > 0 else {
            throw APIError.unauthorized
        }
        return claims
    }
}

struct SessionClaims: Decodable {
    let uid: String
    /// The current Worker encodes epoch milliseconds, not JWT epoch seconds.
    let exp: Double
    var expiry: Date { Date(timeIntervalSince1970: exp / 1000) }
}

enum SessionStoreError: LocalizedError {
    case keychain(OSStatus)
    case corruptSession

    var errorDescription: String? {
        switch self {
        case .keychain(let status):
            if status == errSecInteractionNotAllowed {
                return "Unlock your device to access your WayPoint session."
            }
            return "Your WayPoint session could not be stored securely (Keychain \(status))."
        case .corruptSession:
            return "The saved WayPoint session could not be read. Please sign in again."
        }
    }
}

@MainActor
final class KeychainSessionStore {
    // Endpoint identity is part of the key: a future environment must use its
    // own key, never reuse a production session on a different server.
    private let service = "com.liddellworks.waypoint.session.d1-staging-v1"
    private let key = "wp_session.v1"

    init() {}

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key,
         kSecAttrSynchronizable as String: false]
    }

    func read() throws -> SavedSession? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SessionStoreError.keychain(status) }
        guard let data = result as? Data,
              let session = try? JSONDecoder().decode(SavedSession.self, from: data) else {
            try clear()
            throw SessionStoreError.corruptSession
        }
        do {
            try session.validate()
            return session
        } catch {
            try clear()
            return nil
        }
    }

    func save(_ session: SavedSession) throws {
        try session.validate()
        let data = try JSONEncoder().encode(session)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        // Update in place: deleting first could lose the existing valid session
        // if the subsequent insert failed.
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = query
            attributes.forEach { insertion[$0.key] = $0.value }
            status = SecItemAdd(insertion as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SessionStoreError.keychain(status) }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SessionStoreError.keychain(status)
        }
    }
}
