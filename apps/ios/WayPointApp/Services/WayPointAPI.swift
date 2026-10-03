import Foundation
import WayPointCore

enum APIError: LocalizedError {
    case unauthorized
    case invalidResponse
    case server(String)
    case bootstrapRequired
    case protocolMismatch

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Your sign-in was not accepted or has expired. Please sign in again."
        case .invalidResponse: return "WayPoint returned an unexpected response. Your local trips have not been replaced."
        case .server(let message): return message
        case .bootstrapRequired: return "Access or database history changed. WayPoint needs a fresh authorized snapshot."
        case .protocolMismatch: return "This server does not support the production sync protocol used by this app."
        }
    }
}

/// No redirected request is ever sent, even to the same host. This protects the
/// manually attached Cookie header and catches accidental origin/path changes.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// Production origin is pinned. Production sessions, snapshots and queued
/// mutations are isolated from the previous staging environment.
@MainActor
final class WayPointAPI {
    static let origin = "https://liddellworks.com"
    static let environmentID = "d1-production-v1"
    private enum Endpoint: String {
        case login, whoami, logout
        case capabilities = "v1/sync/capabilities"
        case bootstrap = "v1/sync/bootstrap"
        case changes = "v1/sync/changes"
        case mutations = "v1/sync/mutations"
    }
    private let transport: URLSession
    private let redirectDelegate: NoRedirectDelegate
    private let decoder = JSONDecoder()

    /// Tests may supply an ephemeral configuration with a URLProtocol stub.
    /// Cookie, cache, and credential isolation are enforced for every configuration.
    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        configuration.waitsForConnectivity = false
        redirectDelegate = NoRedirectDelegate()
        transport = URLSession(configuration: configuration, delegate: redirectDelegate, delegateQueue: nil)
    }

    deinit { transport.invalidateAndCancel() }

    func login(username: String, password: String) async throws -> SavedSession {
        let username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !username.isEmpty, !password.isEmpty,
              username.utf16.count <= 80, password.utf16.count <= 256 else {
            throw APIError.server("Enter your username and password (maximum 80 and 256 characters).")
        }
        let body = try JSONEncoder().encode(LoginBody(username: username, password: password))
        let (data, response) = try await send(.login, method: "POST", body: body)
        guard let result = try? decoder.decode(LoginResponse.self, from: data),
              result.status == "ok", !result.id.isEmpty, !result.username.isEmpty else {
            throw APIError.invalidResponse
        }
        let account = Account(id: result.id, username: result.username)
        return try extractSession(response: response, account: account)
    }

    func whoAmI(session: SavedSession) async throws -> Account {
        let (data, _) = try await send(.whoami, session: session)
        guard let result = try? decoder.decode(IdentityResponse.self, from: data) else {
            throw APIError.invalidResponse
        }
        guard result.loggedIn else { throw APIError.unauthorized }
        guard let id = result.id, let username = result.username,
              !id.isEmpty, !username.isEmpty else { throw APIError.invalidResponse }
        guard id == session.account.id else { throw APIError.unauthorized }
        return Account(id: id, username: username)
    }

    func capabilities(session: SavedSession) async throws -> D1Capabilities {
        let (data, _) = try await send(.capabilities, session: session)
        let result = try decoder.decode(D1Capabilities.self, from: data)
        guard result.protocolVersion == 1, result.environment == "production", result.productionReady,
              result.recordRevisions, !result.legacyTripRevisionsAccepted,
              result.maxMutationBatch >= 1, result.maxPageSize >= 1 else {
            throw APIError.protocolMismatch
        }
        return result
    }

    func bootstrap(session: SavedSession, cursor: String? = nil) async throws -> D1BootstrapPage {
        let (data, _) = try await send(.bootstrap, session: session, cursor: cursor)
        let page = try decoder.decode(D1BootstrapPage.self, from: data)
        guard page.protocolVersion == 1 else { throw APIError.protocolMismatch }
        return page
    }

    func changes(session: SavedSession, cursor: String) async throws -> D1ChangesPage {
        let (data, _) = try await send(.changes, session: session, cursor: cursor)
        let page = try decoder.decode(D1ChangesPage.self, from: data)
        guard page.protocolVersion == 1 else { throw APIError.protocolMismatch }
        return page
    }

    func mutations(session: SavedSession, request: D1MutationRequest) async throws -> D1MutationResponse {
        let body = try JSONEncoder().encode(request)
        let (data, _) = try await send(.mutations, method: "POST", body: body, session: session)
        let response = try decoder.decode(D1MutationResponse.self, from: data)
        guard response.protocolVersion == 1 else { throw APIError.protocolMismatch }
        return response
    }

    /// The current server clears its browser cookie; it does not revoke signed
    /// tokens. The caller must always clear its local Keychain on sign-out too.
    func logout(session: SavedSession) async throws {
        let (data, _) = try await send(.logout, method: "POST", session: session)
        guard let result = try? decoder.decode(StatusResponse.self, from: data),
              result.status == "ok" else { throw APIError.invalidResponse }
    }

    private func send(
        _ endpoint: Endpoint, method: String = "GET", body: Data? = nil,
        session: SavedSession? = nil, cursor: String? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        guard var components = URLComponents(string: Self.origin + "/WayPoint/api/\(endpoint.rawValue)") else {
            throw APIError.invalidResponse
        }
        if endpoint == .bootstrap || endpoint == .changes {
            components.queryItems = [URLQueryItem(name: "limit", value: "100")]
            if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        }
        guard let url = components.url else {
            throw APIError.invalidResponse
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.httpBody = body
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let session {
            try session.validate()
            request.setValue("wp_session=\(session.cookieValue)", forHTTPHeaderField: "Cookie")
        }
        try Task.checkCancellation()
        let (data, response) = try await transport.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, response.url == url else {
            throw APIError.invalidResponse
        }
        switch response.statusCode {
        case 200...299: break
        case 401: throw APIError.unauthorized
        case 403: throw APIError.server("Your account does not have permission for this request.")
        case 429:
            throw APIError.server("Too many requests. Wait a few minutes, then try again.")
        case 300..<400:
            throw APIError.server("The WayPoint server redirected this request. Check the configured deployment before trying again.")
        case 409:
            let detail = try? decoder.decode(D1ErrorResponse.self, from: data)
            if detail?.error.code == "bootstrap_required" { throw APIError.bootstrapRequired }
            throw APIError.server(detail?.error.message ?? "This change conflicts with the server.")
        default:
            let detail = (try? decoder.decode(D1ErrorResponse.self, from: data))?.error.message
                ?? (try? decoder.decode(ErrorResponse.self, from: data))?.error
            let message = detail.map { String($0.prefix(240)) }
                ?? "WayPoint could not complete the request (HTTP \(response.statusCode))."
            throw APIError.server(message)
        }
        guard response.mimeType?.lowercased() == "application/json",
              !data.isEmpty else { throw APIError.invalidResponse }
        return (data, response)
    }

    private func extractSession(response: HTTPURLResponse, account: Account) throws -> SavedSession {
        guard let url = response.url,
              url.scheme == "https", url.host == URL(string: Self.origin)?.host,
              url.path == "/WayPoint/api/login",
              let raw = response.value(forHTTPHeaderField: "Set-Cookie") else {
            throw APIError.invalidResponse
        }
        // Enforce the worker's host-only cookie, not a parent-domain wildcard.
        // Unique attribute names avoid accepting conflicting duplicate scopes.
        var attributes: [String: String] = [:]
        let components = raw.split(separator: ";", omittingEmptySubsequences: false)
        for component in components.dropFirst() {
            let pair = component.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let first = pair.first else { throw APIError.invalidResponse }
            let name = first.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !name.isEmpty, attributes[name] == nil else { throw APIError.invalidResponse }
            attributes[name] = pair.count == 2
                ? pair[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
        }
        guard attributes["domain"] == nil,
              attributes["path"] == "/WayPoint",
              attributes["secure"] != nil, attributes["httponly"] != nil,
              let rawAge = attributes["max-age"], let age = TimeInterval(rawAge),
              age.isFinite, age > 0, age <= 30 * 24 * 60 * 60 else {
            throw APIError.invalidResponse
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": raw], for: url)
        guard cookies.count == 1, let cookie = cookies.first,
              cookie.name == "wp_session", cookie.domain.lowercased() == URL(string: Self.origin)?.host,
              cookie.path == "/WayPoint", cookie.isSecure, cookie.isHTTPOnly else {
            throw APIError.invalidResponse
        }
        let claims = try SavedSession.claims(from: cookie.value)
        let expiry = min(claims.expiry, Date().addingTimeInterval(age))
        let session = SavedSession(account: account, cookieValue: cookie.value, expiresAt: expiry)
        try session.validate()
        return session
    }
}

private struct LoginBody: Encodable { let username: String; let password: String }
private struct LoginResponse: Decodable { let status: String; let id: String; let username: String }
private struct IdentityResponse: Decodable { let loggedIn: Bool; let id: String?; let username: String? }
private struct StatusResponse: Decodable { let status: String }
private struct ErrorResponse: Decodable { let error: String }

struct D1Capabilities: Decodable {
    let protocolVersion: Int
    let environment: String
    let recordRevisions: Bool
    let maxMutationBatch: Int
    let maxPageSize: Int
    let productionReady: Bool
    let legacyTripRevisionsAccepted: Bool
}
private struct D1ErrorResponse: Decodable {
    struct Detail: Decodable { let code: String; let message: String }
    let error: Detail
}
