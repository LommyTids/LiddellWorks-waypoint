import XCTest
@testable import WayPointCore

final class GoogleSignInTests: XCTestCase {
    private let clientID = "123-abc.apps.googleusercontent.com"

    private func request(state: String = "expected-state", verifier: String? = nil) throws -> GoogleSignInRequest {
        try GoogleSignInRequest(clientID: clientID, nonce: "abc.def.012", state: state, codeVerifier: verifier)
    }

    private func query(_ url: URL) throws -> [String: String] {
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }

    private func callback(_ query: String) throws -> URL {
        try XCTUnwrap(URL(string: "com.googleusercontent.apps.123-abc:/oauth2redirect?\(query)"))
    }

    func testChallengeMatchesThePKCESpecificationExample() throws {
        // RFC 7636, Appendix B.
        let value = try request(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(value.codeChallenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testRedirectIsTheReversedClientID() throws {
        let value = try request()
        XCTAssertEqual(value.callbackScheme, "com.googleusercontent.apps.123-abc")
        XCTAssertEqual(value.redirectURI, "com.googleusercontent.apps.123-abc:/oauth2redirect")
    }

    func testAuthorizationURLAsksForACodeBoundToThisAttempt() throws {
        let value = try request()
        let url = value.authorizationURL
        XCTAssertEqual(url.host, "accounts.google.com")
        XCTAssertEqual(url.path, "/o/oauth2/v2/auth")
        XCTAssertEqual(try query(url), [
            "client_id": clientID, "redirect_uri": value.redirectURI, "response_type": "code",
            "scope": "openid email", "code_challenge": value.codeChallenge, "code_challenge_method": "S256",
            "nonce": "abc.def.012", "state": "expected-state", "prompt": "select_account"
        ])
    }

    func testEachAttemptGetsItsOwnSecrets() throws {
        let first = try GoogleSignInRequest(clientID: clientID, nonce: "n")
        let second = try GoogleSignInRequest(clientID: clientID, nonce: "n")
        XCTAssertNotEqual(first.state, second.state)
        XCTAssertNotEqual(first.codeVerifier, second.codeVerifier)
        XCTAssertEqual(first.codeVerifier.count, 43)
        XCTAssertNil(first.codeVerifier.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
    }

    func testRefusesClientIDsThatCouldNotFormARedirect() {
        for value in ["", ".apps.googleusercontent.com", "123.example.com", "a/b.apps.googleusercontent.com", "a.b.apps.googleusercontent.com"] {
            XCTAssertThrowsError(try GoogleSignInRequest(clientID: value, nonce: "n"), value) {
                XCTAssertEqual($0 as? GoogleSignInError, .invalidClientID)
            }
        }
    }

    func testCallbackReturnsTheCodeForThisAttempt() throws {
        let code = try request().code(fromCallback: callback("state=expected-state&code=4%2F0Abc"))
        XCTAssertEqual(code, "4/0Abc")
    }

    func testCallbackForAnotherAttemptIsRefused() throws {
        let value = try request()
        for query in ["state=other&code=stolen", "code=stolen", "state=other&error=access_denied"] {
            XCTAssertThrowsError(try value.code(fromCallback: callback(query)), query) {
                XCTAssertEqual($0 as? GoogleSignInError, .invalidCallback)
            }
        }
    }

    func testCallbackAtAnotherAddressIsRefused() throws {
        let value = try request()
        for text in ["com.example.other:/oauth2redirect?state=expected-state&code=x",
                     "com.googleusercontent.apps.123-abc:/elsewhere?state=expected-state&code=x"] {
            XCTAssertThrowsError(try value.code(fromCallback: XCTUnwrap(URL(string: text))), text) {
                XCTAssertEqual($0 as? GoogleSignInError, .invalidCallback)
            }
        }
    }

    func testDecliningIsACancelAndOtherErrorsAreFailures() throws {
        let value = try request()
        XCTAssertThrowsError(try value.code(fromCallback: callback("state=expected-state&error=access_denied"))) {
            XCTAssertEqual($0 as? GoogleSignInError, .cancelled)
        }
        for query in ["state=expected-state&error=server_error", "state=expected-state", "state=expected-state&code="] {
            XCTAssertThrowsError(try value.code(fromCallback: callback(query)), query) {
                XCTAssertEqual($0 as? GoogleSignInError, .invalidCallback)
            }
        }
    }

    func testTokenRequestEncodesCodeAndCarriesNoSecret() throws {
        let value = try request(verifier: "the-verifier")
        let body = try XCTUnwrap(String(data: value.tokenRequestBody(code: "4/0A+b c"), encoding: .utf8))
        XCTAssertEqual(body, "client_id=123-abc.apps.googleusercontent.com&code=4%2F0A%2Bb%20c&code_verifier=the-verifier"
            + "&grant_type=authorization_code&redirect_uri=com.googleusercontent.apps.123-abc%3A%2Foauth2redirect")
    }

    func testOnlyTheIDTokenIsReadFromGooglesReply() throws {
        let reply = Data(#"{"access_token":"a","expires_in":3599,"id_token":"the.id.token","token_type":"Bearer"}"#.utf8)
        XCTAssertEqual(try GoogleSignInRequest.idToken(fromTokenResponse: reply), "the.id.token")
        for text in [#"{"access_token":"a"}"#, #"{"id_token":""}"#, "not json"] {
            XCTAssertThrowsError(try GoogleSignInRequest.idToken(fromTokenResponse: Data(text.utf8)), text) {
                XCTAssertEqual($0 as? GoogleSignInError, .missingIDToken)
            }
        }
    }
}
