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
        case identity = "login/identity"
        case loginConfig = "login/config"
        case loginNonce = "login/nonce"
        case accountDeletion = "account/deletion"
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

    func login(phone: String) async throws -> SavedSession {
        let phone = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !phone.isEmpty, phone.utf16.count <= 80 else {
            throw APIError.server("Enter your registered phone number, including its country code.")
        }
        return try await login(body: JSONEncoder().encode(PhoneLoginBody(phone: phone)))
    }

    func login(username: String, password: String) async throws -> SavedSession {
        let username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !username.isEmpty, !password.isEmpty,
              username.utf16.count <= 80, password.utf16.count <= 256 else {
            throw APIError.server("Enter your username and password (maximum 80 and 256 characters).")
        }
        let body = try JSONEncoder().encode(LoginBody(username: username, password: password))
        return try await login(body: body)
    }

    /// The server finds the account from the token's verified subject. Name and
    /// email are never sent, and invites are redeemed on the website.
    func login(provider: IdentityProvider, idToken: String) async throws -> SavedSession {
        let body = try JSONEncoder().encode(IdentityLoginBody(provider: provider.rawValue, idToken: idToken))
        return try await login(.identity, body: body)
    }

    private func login(_ endpoint: Endpoint = .login, body: Data) async throws -> SavedSession {
        let (data, response) = try await send(endpoint, method: "POST", body: body)
        guard let result = try? decoder.decode(LoginResponse.self, from: data),
              result.status == "ok", !result.id.isEmpty, !result.username.isEmpty else {
            throw APIError.invalidResponse
        }
        let account = Account(id: result.id, username: result.username)
        return try extractSession(response: response, account: account)
    }

    /// A provider is offered only once the server names a client ID for this app.
    /// Otherwise its token's audience would be refused.
    func signInOptions() async throws -> SignInOptions {
        let (data, _) = try await send(.loginConfig)
        guard let config = try? decoder.decode(LoginConfigResponse.self, from: data) else {
            throw APIError.invalidResponse
        }
        let offersApple = config.providers["apple"]?.nativeClientId != nil
        return SignInOptions(appleNonce: offersApple ? try await loginNonce() : nil,
                             googleClientID: config.providers["google"]?.nativeClientId,
                             phoneLogin: config.phoneLogin)
    }

    func loginNonce() async throws -> String {
        let (data, _) = try await send(.loginNonce)
        guard let result = try? decoder.decode(NonceResponse.self, from: data), !result.nonce.isEmpty else {
            throw APIError.invalidResponse
        }
        return result.nonce
    }

    /// Google is the only host besides WayPoint that this app calls directly. The
    /// reply's ID token goes on to WayPoint and its access token is dropped.
    func googleIDToken(for attempt: GoogleSignInRequest, code: String) async throws -> String {
        var request = URLRequest(url: GoogleSignInRequest.tokenEndpoint, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "POST"
        request.httpBody = attempt.tokenRequestBody(code: code)
        request.httpShouldHandleCookies = false
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        try Task.checkCancellation()
        let (data, response) = try await transport.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url == GoogleSignInRequest.tokenEndpoint else {
            throw GoogleSignInError.missingIDToken
        }
        return try GoogleSignInRequest.idToken(fromTokenResponse: data)
    }

    func whoAmI(session: SavedSession) async throws -> IdentityCheck {
        let (data, response) = try await send(.whoami, session: session)
        guard let result = try? decoder.decode(IdentityResponse.self, from: data) else {
            throw APIError.invalidResponse
        }
        guard result.loggedIn else { throw APIError.unauthorized }
        guard let id = result.id, let username = result.username,
              !id.isEmpty, !username.isEmpty else { throw APIError.invalidResponse }
        guard id == session.account.id else { throw APIError.unauthorized }
        // Renewal is optional: a missing or unusable cookie leaves the current
        // session in place, and only a later expiry for this account is adopted.
        let renewed = (try? extractSession(response: response, account: session.account, appleUserID: session.appleUserID))
            .flatMap { $0.expiresAt > session.expiresAt ? $0 : nil }
        return IdentityCheck(account: Account(id: id, username: username), renewed: renewed)
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

    func accountDeletionSummary(session: SavedSession) async throws -> AccountDeletionSummary {
        let (data, _) = try await send(.accountDeletion, session: session)
        guard let summary = try? decoder.decode(AccountDeletionSummary.self, from: data) else {
            throw APIError.invalidResponse
        }
        return summary
    }

    /// The code is single use and comes from Apple at this moment, not from sign-in.
    /// Returns whether the server ended WayPoint's access to the person's Apple ID.
    func deleteAccount(session: SavedSession, appleAuthorizationCode: String?) async throws -> Bool {
        let body = try JSONEncoder().encode(AccountDeletionBody(appleAuthorizationCode: appleAuthorizationCode))
        let (data, _) = try await send(.accountDeletion, method: "POST", body: body, session: session)
        guard let result = try? decoder.decode(AccountDeletionResponse.self, from: data),
              result.status == "ok" else { throw APIError.invalidResponse }
        return result.appleRevoked
    }

    private func send(
        _ endpoint: Endpoint, method: String = "GET", body: Data? = nil,
        session: SavedSession? = nil, cursor: String? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        guard var components = URLComponents(string: Self.origin + "/waypoint/api/\(endpoint.rawValue)") else {
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
        // A refused sign-in is an answer for the person, not a sync failure: the
        // server says why, for example that phone sign-in has ended.
        if endpoint == .login || endpoint == .identity, [401, 403, 409].contains(response.statusCode) {
            let detail = try? decoder.decode(LoginErrorResponse.self, from: data)
            throw APIError.server(detail.map { String($0.error.prefix(240)) }
                ?? "Could not sign in. Check your registered phone number or UberUser credentials.")
        }
        // These answers are for the person to read, and come in either error format.
        // The sync service's own failure message talks about mutation IDs, so it isn't.
        if endpoint == .accountDeletion, [403, 409, 503].contains(response.statusCode) {
            let structured = try? decoder.decode(D1ErrorResponse.self, from: data)
            let detail = structured?.error.code == "service_unavailable" ? nil
                : (try? decoder.decode(LoginErrorResponse.self, from: data))?.error ?? structured?.error.message
            throw APIError.server(detail.map { String($0.prefix(240)) }
                ?? "Your account has not been deleted. Please try again.")
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

    private func extractSession(response: HTTPURLResponse, account: Account, appleUserID: String? = nil) throws -> SavedSession {
        guard let url = response.url,
              url.scheme == "https", url.host == URL(string: Self.origin)?.host,
              ["/waypoint/api/login", "/waypoint/api/login/identity", "/waypoint/api/whoami"].contains(url.path),
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
              ["/waypoint", "/WayPoint"].contains(attributes["path"] ?? ""),
              attributes["secure"] != nil, attributes["httponly"] != nil,
              let rawAge = attributes["max-age"], let age = TimeInterval(rawAge),
              age.isFinite, age > 0, age <= 30 * 24 * 60 * 60 else {
            throw APIError.invalidResponse
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": raw], for: url)
        guard cookies.count == 1, let cookie = cookies.first,
              cookie.name == "wp_session", cookie.domain.lowercased() == URL(string: Self.origin)?.host,
              ["/waypoint", "/WayPoint"].contains(cookie.path), cookie.isSecure, cookie.isHTTPOnly else {
            throw APIError.invalidResponse
        }
        let claims = try SavedSession.claims(from: cookie.value)
        let expiry = min(claims.expiry, Date().addingTimeInterval(age))
        let session = SavedSession(account: account, cookieValue: cookie.value, expiresAt: expiry, appleUserID: appleUserID)
        try session.validate()
        return session
    }
}

private struct LoginErrorResponse: Decodable { let error: String }
private struct PhoneLoginBody: Encodable { let phone: String }
private struct IdentityLoginBody: Encodable { let provider: String; let idToken: String }
private struct NonceResponse: Decodable { let nonce: String }
private struct LoginConfigResponse: Decodable {
    struct Provider: Decodable { let nativeClientId: String? }
    let providers: [String: Provider]
    let phoneLogin: Bool
}
private struct LoginBody: Encodable { let username: String; let password: String }
private struct LoginResponse: Decodable { let status: String; let id: String; let username: String }
private struct IdentityResponse: Decodable { let loggedIn: Bool; let id: String?; let username: String? }
private struct StatusResponse: Decodable { let status: String }
private struct ErrorResponse: Decodable { let error: String }
private struct AccountDeletionBody: Encodable {
    var confirm = "DELETE"
    let appleAuthorizationCode: String?
}
private struct AccountDeletionResponse: Decodable { let status: String; let appleRevoked: Bool }

enum IdentityProvider: String { case apple, google }

/// How this app may sign in, as the server currently offers it.
struct SignInOptions: Equatable {
    /// Present when Apple is offered. Apple's button builds its request without
    /// waiting, so its nonce has to be in hand before the tap.
    var appleNonce: String?
    var googleClientID: String?
    var phoneLogin: Bool

    /// Named for the help text: "Apple or Google", or whichever one is offered.
    var providerNames: String? {
        let names = [appleNonce == nil ? nil : "Apple", googleClientID == nil ? nil : "Google"].compactMap { $0 }
        return names.isEmpty ? nil : names.joined(separator: " or ")
    }

    #if DEBUG
    /// For UI tests and screenshots, because production offers what it offers.
    /// Launch with `-WayPointSignInPreview providers` or `with-phone`.
    static var launchPreview: SignInOptions? {
        guard let mode = UserDefaults.standard.string(forKey: "WayPointSignInPreview") else { return nil }
        return SignInOptions(appleNonce: "preview", googleClientID: "preview.apps.googleusercontent.com",
                             phoneLogin: mode == "with-phone")
    }
    #endif
}

/// What deleting this account would do, as the server reports it.
struct AccountDeletionSummary: Decodable, Equatable {
    let linkedSignIn: String?
    /// Whether the server holds the key that ends WayPoint's access to an Apple ID.
    let appleRevocation: Bool
    /// Why this account can't be deleted here, when it can't.
    let blocked: String?
    let tripsErased: Int
    let tripsHandedOver: Int
    let tripsLeft: Int

    var isLinkedToApple: Bool { linkedSignIn == "apple" }
    /// There's no use asking Apple for a code the server can't spend.
    var confirmsWithApple: Bool { isLinkedToApple && appleRevocation }

    static func isConfirmed(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "DELETE"
    }

    /// Plain statements for the confirmation screen, in the order they matter.
    func consequences(pendingChanges: Int) -> [String] {
        var lines = ["Your account and sign-in are removed for good. This can't be undone."]
        if tripsErased > 0 {
            lines.append("\(trips(tripsErased)) only you can open will be erased.")
        }
        if tripsHandedOver > 0 {
            lines.append("\(trips(tripsHandedOver)) you share with other people \(tripsHandedOver == 1 ? "stays" : "stay") with them, without your name.")
        }
        if tripsLeft > 0 {
            lines.append("You'll lose access to \(trips(tripsLeft)) shared with you.")
        }
        if pendingChanges > 0 {
            lines.append("\(pendingChanges == 1 ? "1 change" : "\(pendingChanges) changes") on this device that \(pendingChanges == 1 ? "hasn't" : "haven't") synced will be lost.")
        }
        lines.append("Saved trips on this device are removed too.")
        return lines
    }

    private func trips(_ count: Int) -> String { count == 1 ? "1 trip" : "\(count) trips" }
}

/// `renewed` is a longer-lived replacement session, when the server offered one.
struct IdentityCheck {
    let account: Account
    let renewed: SavedSession?
}

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
