import CryptoKit
import Foundation

public enum GoogleSignInError: LocalizedError, Equatable {
    case invalidClientID
    /// The person closed Google's page or declined. Nothing to report.
    case cancelled
    /// The callback did not answer this attempt, or Google reported a failure.
    case invalidCallback
    case missingIDToken

    public var errorDescription: String? { "Google sign-in did not finish. Please try again." }
}

/// One attempt at Google sign-in from the app: the authorization code flow with
/// PKCE, as a public client with no secret. WayPoint's server accepts only the
/// resulting ID token, so the access token Google also returns is never kept.
public struct GoogleSignInRequest: Sendable {
    public static let tokenEndpoint = URL(string: "https://oauth2.googleapis.com/token")!
    private static let authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
    private static let clientIDSuffix = ".apps.googleusercontent.com"

    public let clientID: String
    public let nonce: String
    public let state: String
    public let codeVerifier: String
    /// Google's iOS clients redirect to the client ID with its fields reversed.
    /// The system browser session catches it, so no URL type is registered.
    public let callbackScheme: String

    /// `nonce` comes from WayPoint's server, which checks it inside the ID token.
    public init(clientID: String, nonce: String, state: String? = nil, codeVerifier: String? = nil) throws {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")
        guard clientID.hasSuffix(Self.clientIDSuffix) else { throw GoogleSignInError.invalidClientID }
        let name = String(clientID.dropLast(Self.clientIDSuffix.count))
        guard !name.isEmpty, name.unicodeScalars.allSatisfy(allowed.contains) else {
            throw GoogleSignInError.invalidClientID
        }
        self.clientID = clientID
        self.nonce = nonce
        self.state = state ?? Self.randomToken()
        self.codeVerifier = codeVerifier ?? Self.randomToken()
        callbackScheme = "com.googleusercontent.apps." + name
    }

    public var redirectURI: String { callbackScheme + ":/oauth2redirect" }

    public var codeChallenge: String {
        Self.base64URL(Data(SHA256.hash(data: Data(codeVerifier.utf8))))
    }

    public var authorizationURL: URL {
        // Google asks for `email` or `profile` beside `openid`. The server reads
        // neither: it keeps only the token's subject.
        let query = Self.formEncoded([
            ("client_id", clientID), ("redirect_uri", redirectURI), ("response_type", "code"),
            ("scope", "openid email"), ("code_challenge", codeChallenge), ("code_challenge_method", "S256"),
            ("nonce", nonce), ("state", state), ("prompt", "select_account")
        ])
        return URL(string: Self.authorizationEndpoint + "?" + query)!
    }

    /// Reads the authorization code from Google's redirect. `state` proves the
    /// redirect belongs to this attempt and not to one started by another app.
    public func code(fromCallback url: URL) throws -> String {
        guard url.scheme == callbackScheme, url.path == "/oauth2redirect",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            throw GoogleSignInError.invalidCallback
        }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw GoogleSignInError.invalidCallback }
        if let failure = value("error") {
            throw failure == "access_denied" ? GoogleSignInError.cancelled : GoogleSignInError.invalidCallback
        }
        guard let code = value("code"), !code.isEmpty else { throw GoogleSignInError.invalidCallback }
        return code
    }

    public func tokenRequestBody(code: String) -> Data {
        Data(Self.formEncoded([
            ("client_id", clientID), ("code", code), ("code_verifier", codeVerifier),
            ("grant_type", "authorization_code"), ("redirect_uri", redirectURI)
        ]).utf8)
    }

    public static func idToken(fromTokenResponse data: Data) throws -> String {
        guard let response = try? JSONDecoder().decode(TokenResponse.self, from: data),
              let token = response.id_token, !token.isEmpty else {
            throw GoogleSignInError.missingIDToken
        }
        return token
    }

    private struct TokenResponse: Decodable { let id_token: String? }

    /// 256 random bits give the 43 characters that PKCE sets as its minimum.
    private static func randomToken() -> String {
        base64URL(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Google's codes contain `/`, and `URLQueryItem` leaves `+` alone, so every
    /// value is encoded down to the RFC 3986 unreserved characters.
    private static func formEncoded(_ pairs: [(String, String)]) -> String {
        let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return pairs.map { name, value in
            name + "=" + (value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")
        }.joined(separator: "&")
    }
}
