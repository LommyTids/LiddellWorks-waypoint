import AuthenticationServices
import XCTest
import Foundation
import SwiftData
import WayPointCore
@testable import WayPoint

@MainActor
final class WayPointAPITests: XCTestCase {
    private func api(status: Int, body: String, headers: [String: String] = [:], inspect: @escaping (URLRequest) -> Void = { _ in }) -> WayPointAPI {
        StubProtocol.handler = { request in
            inspect(request)
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                    headerFields: headers.merging(["Content-Type": "application/json"]) { _, right in right })!, Data(body.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return WayPointAPI(configuration: configuration)
    }

    private func session() -> SavedSession { testSession(expiresIn: 3500) }

    func testLoginAcceptsHostOnlyWorkerCookie() async throws {
        let cookie = session().cookieValue
        let client = api(status: 200,
                         body: "{\"status\":\"ok\",\"id\":\"test_account\",\"username\":\"Tester\"}",
                         headers: ["Set-Cookie": "wp_session=\(cookie); Path=/WayPoint; Secure; HttpOnly; SameSite=Lax; Max-Age=604800"]) { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.scheme, "https")
            XCTAssertEqual(request.url?.host, "liddellworks.com")
            XCTAssertEqual(request.url?.path, "/waypoint/api/login")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        }
        let saved = try await client.login(username: " Tester ", password: "test-only-password")
        XCTAssertEqual(saved.account.id, "test_account")
        XCTAssertEqual(saved.cookieValue, cookie)
        XCTAssertGreaterThan(saved.expiresAt, Date())
        try saved.validate()
    }

    func testPhoneLoginSendsOnlyPhoneAndRetainsAccountID() async throws {
        let cookie = session().cookieValue
        let client = api(status: 200,
                         body: "{\"status\":\"ok\",\"id\":\"test_account\",\"username\":\"Tester\"}",
                         headers: ["Set-Cookie": "wp_session=\(cookie); Path=/waypoint; Secure; HttpOnly; SameSite=Lax; Max-Age=604800"]) { request in
            let payload = try? JSONSerialization.jsonObject(with: requestBody(request)) as? [String: String]
            XCTAssertEqual(payload, ["phone": "+44 7700 900123"])
            XCTAssertEqual(request.url?.path, "/waypoint/api/login")
        }
        let saved = try await client.login(phone: " +44 7700 900123 ")
        XCTAssertEqual(saved.account.id, "test_account")
        XCTAssertEqual(saved.cookieValue, cookie)
    }

    func testUnregisteredPhoneShowsLoginError() async throws {
        let client = api(status: 401, body: "{\"error\":\"Phone number is not registered.\"}")
        do { _ = try await client.login(phone: "+447700900000"); XCTFail("Expected rejected phone") }
        catch APIError.server(let message) { XCTAssertEqual(message, "Phone number is not registered.") }
    }

    func testEndedPhoneSignInSaysWhy() async throws {
        let client = api(status: 403, body: "{\"error\":\"Phone sign-in has ended.\"}")
        do { _ = try await client.login(phone: "+447700900000"); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "Phone sign-in has ended.") }
    }

    func testIdentityLoginSendsOnlyProviderAndTokenAndKeepsItsCookie() async throws {
        let cookie = session().cookieValue
        let client = api(status: 200, body: "{\"status\":\"ok\",\"id\":\"test_account\",\"username\":\"Tester\"}",
                         headers: ["Set-Cookie": "wp_session=\(cookie); Path=/waypoint; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000"]) { request in
            let payload = try? JSONSerialization.jsonObject(with: requestBody(request)) as? [String: String]
            XCTAssertEqual(payload, ["provider": "apple", "idToken": "the.id.token"])
            XCTAssertEqual(request.url?.path, "/waypoint/api/login/identity")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        }
        let saved = try await client.login(provider: .apple, idToken: "the.id.token")
        XCTAssertEqual(saved.account.id, "test_account")
        XCTAssertEqual(saved.cookieValue, cookie)
    }

    func testRefusedIdentityShowsTheServersReason() async throws {
        for status in [401, 403, 409, 503] {
            let client = api(status: status, body: "{\"error\":\"Reason \(status)\"}")
            do { _ = try await client.login(provider: .google, idToken: "token"); XCTFail("Expected refusal") }
            catch APIError.server(let message) { XCTAssertEqual(message, "Reason \(status)") }
        }
    }

    func testSyncRefusalsKeepTheirOwnMeaning() async throws {
        let forbidden = api(status: 403, body: "{\"error\":\"Should not be shown\"}")
        do { _ = try await forbidden.bootstrap(session: session()); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "Your account does not have permission for this request.") }
        let conflict = api(status: 409, body: "{\"error\":{\"code\":\"conflict\",\"message\":\"Changed elsewhere\"}}")
        do { _ = try await conflict.bootstrap(session: session()); XCTFail("Expected conflict") }
        catch APIError.server(let message) { XCTAssertEqual(message, "Changed elsewhere") }
    }

    func testOnlyProvidersWithAnAppClientIDAreOffered() async throws {
        let body = "{\"nonce\":\"abc.def.012\",\"providers\":{\"apple\":{\"clientId\":\"web\",\"nativeClientId\":null},"
            + "\"google\":{\"clientId\":\"web\",\"nativeClientId\":\"app.apps.googleusercontent.com\"}},\"phoneLogin\":false}"
        let options = try await api(status: 200, body: body).signInOptions()
        XCTAssertEqual(options, SignInOptions(appleNonce: nil, googleClientID: "app.apps.googleusercontent.com", phoneLogin: false))
        XCTAssertEqual(options.providerNames, "Google")
    }

    func testAppleIsOfferedWithItsNonceInHand() async throws {
        let body = "{\"nonce\":\"abc.def.012\",\"providers\":{\"apple\":{\"clientId\":\"web\",\"nativeClientId\":\"com.example\"}},\"phoneLogin\":true}"
        var paths: [String] = []
        let options = try await api(status: 200, body: body) { paths.append($0.url?.path ?? "") }.signInOptions()
        XCTAssertEqual(options, SignInOptions(appleNonce: "abc.def.012", googleClientID: nil, phoneLogin: true))
        XCTAssertEqual(paths, ["/waypoint/api/login/config", "/waypoint/api/login/nonce"])
    }

    func testUnauthorizedDoesNotDecodeServerData() async throws {
        let client = api(status: 401, body: "{\"error\":{\"code\":\"unauthorized\",\"message\":\"Sign in\"}}")
        do { _ = try await client.bootstrap(session: session()); XCTFail("Expected unauthorized") }
        catch APIError.unauthorized { }
    }

    func testEpochInvalidationRequiresBootstrap() async throws {
        let client = api(status: 409, body: "{\"error\":{\"code\":\"bootstrap_required\",\"message\":\"Permissions changed\"}}")
        do { _ = try await client.changes(session: session(), cursor: "signed_cursor"); XCTFail("Expected bootstrap") }
        catch APIError.bootstrapRequired { }
    }

    func testBootstrapCursorIsEncodedAndCredentialStaysOnProduction() async throws {
        let client = api(status: 200, body: "{\"protocolVersion\":1,\"entities\":[],\"complete\":true,\"nextCursor\":null,\"syncCursor\":\"signed_cursor\"}") { request in
            XCTAssertEqual(request.url?.host, "liddellworks.com")
            XCTAssertEqual(request.url?.path, "/waypoint/api/v1/sync/bootstrap")
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(items?.first(where: { $0.name == "cursor" })?.value, "a+b&cursor")
            XCTAssertTrue(request.value(forHTTPHeaderField: "Cookie")?.hasPrefix("wp_session=") == true)
            XCTAssertFalse(request.httpShouldHandleCookies)
        }
        let result = try await client.bootstrap(session: session(), cursor: "a+b&cursor")
        XCTAssertTrue(result.complete)
    }

    func testCapabilitiesAcceptOnlyReadyProduction() async throws {
        for (environment, ready) in [("staging", true), ("production", false), ("production", true)] {
            let body = "{\"protocolVersion\":1,\"environment\":\"\(environment)\",\"recordRevisions\":true,\"maxMutationBatch\":20,\"maxPageSize\":100,\"productionReady\":\(ready),\"legacyTripRevisionsAccepted\":false}"
            let client = api(status: 200, body: body)
            if environment == "production" && ready {
                _ = try await client.capabilities(session: session())
            } else {
                do { _ = try await client.capabilities(session: session()); XCTFail("Expected protocol mismatch") }
                catch APIError.protocolMismatch { }
            }
        }
        XCTAssertEqual(WayPointAPI.environmentID, "d1-production-v1")
    }

    func testIdentityCheckAdoptsRenewedSession() async throws {
        let current = session()
        let fresh = testSession(expiresIn: 86_400)
        let client = api(status: 200, body: identityBody,
                         headers: ["Set-Cookie": renewalCookie(fresh)])
        let identity = try await client.whoAmI(session: current)
        XCTAssertEqual(identity.renewed?.cookieValue, fresh.cookieValue)
        XCTAssertGreaterThan(try XCTUnwrap(identity.renewed?.expiresAt), current.expiresAt)
    }

    func testIdentityCheckWithoutCookieKeepsSession() async throws {
        let identity = try await api(status: 200, body: identityBody).whoAmI(session: session())
        XCTAssertEqual(identity.account.id, "test_account")
        XCTAssertNil(identity.renewed)
    }

    func testIdentityCheckRejectsUnusableRenewals() async throws {
        let current = session()
        for fresh in [testSession(expiresIn: 60), testSession(expiresIn: 86_400, accountID: "other_account")] {
            let client = api(status: 200, body: identityBody, headers: ["Set-Cookie": renewalCookie(fresh)])
            let identity = try await client.whoAmI(session: current)
            XCTAssertNil(identity.renewed)
        }
        let unscoped = renewalCookie(testSession(expiresIn: 86_400)) + "; Domain=liddellworks.com"
        let identity = try await api(status: 200, body: identityBody, headers: ["Set-Cookie": unscoped]).whoAmI(session: current)
        XCTAssertNil(identity.renewed)
    }

    func testExpiredSessionNamesItsAccountButCannotBeSent() async throws {
        let expired = testSession(expiresIn: -60)
        XCTAssertNoThrow(try expired.validateShape())
        XCTAssertThrowsError(try expired.validate())
        var requests = 0
        let client = api(status: 200, body: identityBody) { _ in requests += 1 }
        do { _ = try await client.whoAmI(session: expired); XCTFail("Expected local rejection") }
        catch APIError.unauthorized { }
        XCTAssertEqual(requests, 0)
    }

    func testHTTP200MutationConflictRemainsAResult() async throws {
        let client = api(status: 200, body: "{\"protocolVersion\":1,\"results\":[{\"mutationId\":\"mut_1\",\"status\":\"conflict\",\"error\":{\"code\":\"revision_conflict\",\"message\":\"Changed\",\"httpStatus\":409}}]}")
        let request = D1MutationRequest(mutations: [D1Mutation(mutationId: "mut_1", tripId: "trip_1", kind: .activity,
                                                              recordId: "act_1", operation: .update, baseRevision: 1,
                                                              data: ["name": .string("Edited activity")])])
        let response = try await client.mutations(session: session(), request: request)
        XCTAssertEqual(response.results.count, 1)
        XCTAssertEqual(response.results.first?.status, "conflict")
        XCTAssertEqual(response.results.first?.error?.code, "revision_conflict")
    }
}

private let identityBody = "{\"loggedIn\":true,\"id\":\"test_account\",\"username\":\"Tester\"}"

/// The Keychain copy is what `exp` claims; `expiresAt` trails it as in production.
private func testSession(expiresIn seconds: TimeInterval, accountID: String = "test_account") -> SavedSession {
    let expiry = Date().addingTimeInterval(seconds)
    let claims = Data("{\"uid\":\"\(accountID)\",\"exp\":\(expiry.timeIntervalSince1970 * 1000 + 1000)}".utf8)
        .base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return SavedSession(account: Account(id: accountID, username: "Tester"),
                        cookieValue: claims + ".testsignature", expiresAt: expiry)
}

/// URLSession may convert httpBody into a stream before URLProtocol.
private func requestBody(_ request: URLRequest) -> Data {
    var body = request.httpBody ?? Data()
    if request.httpBody == nil, let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { XCTFail("Could not read request body stream"); break }
            if count == 0 { break }
            body.append(contentsOf: buffer.prefix(count))
        }
    }
    return body
}

private func renewalCookie(_ session: SavedSession) -> String {
    "wp_session=\(session.cookieValue); Path=/waypoint; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax"
}

/// Drives the real AppModel with an isolated Keychain service, an in-memory store
/// and stubbed routes, because this is where a saved copy can be lost or leaked.
@MainActor
final class AppModelOfflineTests: XCTestCase {
    private let account = Account(id: "test_account", username: "Tester")
    private var directory: URL!
    private var store: WorkspaceStore!
    private var keychain: KeychainSessionStore!
    private var requests = RequestLog()

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let schema = Schema([WorkspaceEnvelope.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        store = WorkspaceStore(container: try ModelContainer(for: schema, configurations: [configuration]), d1Directory: directory)
        keychain = KeychainSessionStore(service: "test." + UUID().uuidString)
        requests = RequestLog()
    }

    override func tearDown() async throws {
        try? keychain.clear()
        try? FileManager.default.removeItem(at: directory)
        StubProtocol.handler = nil
    }

    private func model(routes: @escaping (String) throws -> (Int, String, [String: String])) -> AppModel {
        let log = requests
        StubProtocol.handler = { request in
            let path = request.url?.path.replacingOccurrences(of: "/waypoint/api/", with: "") ?? ""
            log.add(path: path, cookie: request.value(forHTTPHeaderField: "Cookie"), body: requestBody(request))
            let (status, body, headers) = try routes(path)
            return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                    headerFields: headers.merging(["Content-Type": "application/json"]) { _, new in new })!, Data(body.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return AppModel(api: WayPointAPI(configuration: configuration), keychain: keychain, store: store)
    }

    private func savedTrip(account: Account? = nil, id: String = "trip") throws {
        let owner = account ?? self.account
        var state = D1Workspace(account: owner)
        let page = "{\"protocolVersion\":1,\"entities\":[{\"tripId\":\"\(id)\",\"kind\":\"trip\",\"recordId\":\"\(id)\",\"revision\":1,\"operation\":\"upsert\",\"updatedAt\":\"\",\"data\":{\"name\":\"Saved trip\"},\"permission\":{\"role\":\"superuser\",\"companionId\":\"\"}}],\"complete\":true,\"nextCursor\":null,\"syncCursor\":\"cursor\"}"
        try state.publishBootstrap(pages: [JSONDecoder().decode(D1BootstrapPage.self, from: Data(page.utf8))])
        try store.saveD1(state, accountID: owner.id)
    }

    private func signedIn(expiresIn seconds: TimeInterval = 3500) throws {
        // Saved while still in date: a stored session only expires by ageing.
        let session = testSession(expiresIn: seconds)
        try keychain.save(session, at: session.expiresAt.addingTimeInterval(-1))
    }

    private func reloadedState() throws -> D1Workspace? {
        try store.loadD1(accountID: account.id, as: D1Workspace.self)
    }

    private let capabilities = "{\"protocolVersion\":1,\"environment\":\"production\",\"recordRevisions\":true,\"maxMutationBatch\":20,\"maxPageSize\":100,\"productionReady\":true,\"legacyTripRevisionsAccepted\":false}"
    private let emptyChanges = "{\"protocolVersion\":1,\"entities\":[],\"hasMore\":false,\"cursor\":\"next\"}"
    private let bootstrapRequired = "{\"error\":{\"code\":\"bootstrap_required\",\"message\":\"Permissions changed\"}}"

    func testOfflineLaunchOpensSavedTrips() async throws {
        try savedTrip(); try signedIn()
        let model = model { _ in throw URLError(.notConnectedToInternet) }
        await model.start()
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
        XCTAssertFalse(model.needsSignIn)
        XCTAssertNotNil(model.message)
    }

    func testFailedReplacementKeepsSavedTripsOnScreenAndOnDisk() async throws {
        try savedTrip(); try signedIn()
        let model = model { [capabilities, bootstrapRequired] path in
            switch path {
            case "whoami": return (200, identityBody, [:])
            case "v1/sync/capabilities": return (200, capabilities, [:])
            case "v1/sync/changes": return (409, bootstrapRequired, [:])
            default: throw URLError(.notConnectedToInternet)
            }
        }
        await model.start()
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
        let state = try XCTUnwrap(reloadedState())
        XCTAssertEqual(state.isSnapshotStale, true)
        XCTAssertNil(state.cursor)
        XCTAssertEqual(try state.presentationTrips().map(\.name), ["Saved trip"])
    }

    func testCompletedReplacementRemovesRevokedTrips() async throws {
        try savedTrip(); try signedIn()
        let empty = "{\"protocolVersion\":1,\"entities\":[],\"complete\":true,\"nextCursor\":null,\"syncCursor\":\"fresh\"}"
        let log = requests
        let model = model { [capabilities, bootstrapRequired, emptyChanges] path in
            switch path {
            case "whoami": return (200, identityBody, [:])
            case "v1/sync/capabilities": return (200, capabilities, [:])
            case "v1/sync/bootstrap": return (200, empty, [:])
            case "v1/sync/changes":
                // Only the saved cursor is out of date; the fresh one is accepted.
                return log.count(of: path) == 1 ? (409, bootstrapRequired, [:]) : (200, emptyChanges, [:])
            default: throw URLError(.badServerResponse)
            }
        }
        await model.start()
        XCTAssertTrue(model.trips.isEmpty)
        XCTAssertNil(try reloadedState()?.isSnapshotStale)
    }

    func testExpiredSessionOpensSavedTripsWithoutContactingServer() async throws {
        try savedTrip(); try signedIn(expiresIn: -60)
        let model = model { _ in (200, identityBody, [:]) }
        await model.start()
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
        XCTAssertTrue(model.needsSignIn)
        XCTAssertFalse(model.canRefresh)
        XCTAssertEqual(requests.count, 0)
    }

    func testExpiredSessionWithNoSavedTripsAsksForSignIn() async throws {
        try signedIn(expiresIn: -60)
        let model = model { _ in (200, identityBody, [:]) }
        await model.start()
        XCTAssertNil(model.workspace)
        XCTAssertFalse(model.needsSignIn)
        XCTAssertNil(try keychain.read())
    }

    func testServerRefusalClosesSavedCopyButKeepsItOnDisk() async throws {
        try savedTrip(); try signedIn()
        let model = model { _ in (200, "{\"loggedIn\":false}", [:]) }
        await model.start()
        XCTAssertNil(model.workspace)
        XCTAssertFalse(model.needsSignIn)
        XCTAssertNil(try keychain.read())
        XCTAssertNotNil(try reloadedState())
    }

    func testRenewedSessionIsStoredAndUsed() async throws {
        try savedTrip(); try signedIn()
        let fresh = testSession(expiresIn: 86_400)
        let model = model { [capabilities, emptyChanges] path in
            switch path {
            case "whoami": return (200, identityBody, ["Set-Cookie": renewalCookie(fresh)])
            case "v1/sync/capabilities": return (200, capabilities, [:])
            case "v1/sync/changes": return (200, emptyChanges, [:])
            default: throw URLError(.badServerResponse)
            }
        }
        await model.start()
        XCTAssertEqual(try keychain.read()?.cookieValue, fresh.cookieValue)
        XCTAssertEqual(requests.cookies(for: "v1/sync/capabilities"), ["wp_session=\(fresh.cookieValue)"])
        XCTAssertNil(model.message)
    }

    func testSigningInAsAnotherAccountHidesTheExpiredCopy() async throws {
        try savedTrip(); try signedIn(expiresIn: -60)
        let other = testSession(expiresIn: 86_400, accountID: "other_account")
        let login = "{\"status\":\"ok\",\"id\":\"other_account\",\"username\":\"Other\"}"
        let identity = "{\"loggedIn\":true,\"id\":\"other_account\",\"username\":\"Other\"}"
        let model = model { path in
            switch path {
            case "login": return (200, login, ["Set-Cookie": renewalCookie(other)])
            case "whoami": return (200, identity, [:])
            default: throw URLError(.notConnectedToInternet)
            }
        }
        await model.start()
        XCTAssertTrue(model.needsSignIn)
        await model.signIn(phone: "+447700900123")
        XCTAssertNil(model.workspace)
        XCTAssertFalse(model.needsSignIn)
        XCTAssertNotNil(model.message)
    }

    private let googleConfig = "{\"nonce\":\"abc.def.012\",\"providers\":{\"google\":{\"clientId\":\"web\",\"nativeClientId\":\"123-abc.apps.googleusercontent.com\"}},\"phoneLogin\":true}"
    private let loggedIn = "{\"status\":\"ok\",\"id\":\"test_account\",\"username\":\"Tester\"}"
    private let emptyBootstrap = "{\"protocolVersion\":1,\"entities\":[],\"complete\":true,\"nextCursor\":null,\"syncCursor\":\"fresh\"}"

    /// A server that accepts the sign-in and has nothing new to send.
    private func acceptingModel() -> AppModel {
        let fresh = testSession(expiresIn: 86_400)
        return model { [googleConfig, loggedIn, capabilities, emptyBootstrap, emptyChanges] path in
            switch path {
            case "login/config", "login/nonce": return (200, googleConfig, [:])
            case "/token": return (200, "{\"access_token\":\"dropped\",\"id_token\":\"google.id.token\"}", [:])
            case "login/identity": return (200, loggedIn, ["Set-Cookie": renewalCookie(fresh)])
            case "whoami": return (200, identityBody, [:])
            case "v1/sync/capabilities": return (200, capabilities, [:])
            case "v1/sync/bootstrap": return (200, emptyBootstrap, [:])
            case "v1/sync/changes": return (200, emptyChanges, [:])
            default: throw URLError(.badServerResponse)
            }
        }
    }

    func testAppleTokenOpensTheAccountAndStoresItsSession() async throws {
        let model = acceptingModel()
        await model.signIn(provider: .apple, idToken: "apple.id.token")
        XCTAssertNil(model.message)
        XCTAssertEqual(model.accountName, "Tester")
        XCTAssertNotNil(try keychain.read())
        let sent = try XCTUnwrap(requests.bodies(for: "login/identity").first)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: sent) as? [String: String],
                       ["provider": "apple", "idToken": "apple.id.token"])
    }

    func testGoogleRedirectIsExchangedAndOnlyTheIDTokenReachesWayPoint() async throws {
        let model = acceptingModel()
        await model.prepareSignIn()
        var verifierChallenge: String?
        await model.signInWithGoogle { url, scheme in
            XCTAssertEqual(scheme, "com.googleusercontent.apps.123-abc")
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ name: String) -> String { items.first { $0.name == name }?.value ?? "" }
            XCTAssertEqual(value("nonce"), "abc.def.012")
            verifierChallenge = value("code_challenge")
            return URL(string: "\(scheme):/oauth2redirect?state=\(value("state"))&code=4%2Fgoogle-code")!
        }
        XCTAssertNil(model.message)
        XCTAssertEqual(model.accountName, "Tester")
        XCTAssertNotNil(verifierChallenge)
        let exchange = try XCTUnwrap(requests.bodies(for: "/token").first)
        XCTAssertTrue(try XCTUnwrap(String(data: exchange, encoding: .utf8)).contains("code=4%2Fgoogle-code&code_verifier="))
        let sent = try XCTUnwrap(requests.bodies(for: "login/identity").first)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: sent) as? [String: String],
                       ["provider": "google", "idToken": "google.id.token"])
    }

    func testGoogleRedirectForAnotherAttemptNeverReachesGoogleOrWayPoint() async throws {
        let model = acceptingModel()
        await model.prepareSignIn()
        await model.signInWithGoogle { _, scheme in URL(string: "\(scheme):/oauth2redirect?state=forged&code=stolen")! }
        XCTAssertEqual(requests.count(of: "/token"), 0)
        XCTAssertEqual(requests.count(of: "login/identity"), 0)
        XCTAssertEqual(model.message, "Google sign-in did not finish. Please try again.")
        XCTAssertNil(try keychain.read())
    }

    func testClosingGooglesPageSaysNothing() async throws {
        let model = acceptingModel()
        await model.prepareSignIn()
        await model.signInWithGoogle { _, _ in throw ASWebAuthenticationSessionError(.canceledLogin) }
        XCTAssertNil(model.message)
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(requests.count(of: "/token"), 0)
    }

    func testClosingApplesSheetSaysNothingButOtherFailuresDo() {
        let model = acceptingModel()
        model.appleSignInFailed(ASAuthorizationError(.canceled))
        XCTAssertNil(model.message)
        model.appleSignInFailed(ASAuthorizationError(.failed))
        XCTAssertEqual(model.message, "Apple sign-in did not finish. Please try again.")
    }

    func testUnlinkedProviderShowsTheReasonAndKeepsTheExpiredCopyOpen() async throws {
        try savedTrip(); try signedIn(expiresIn: -60)
        let model = model { path in
            guard path == "login/identity" else { throw URLError(.notConnectedToInternet) }
            return (403, "{\"error\":\"This Apple account isn't linked to WayPoint yet.\"}", [:])
        }
        await model.start()
        await model.signIn(provider: .apple, idToken: "apple.id.token")
        XCTAssertEqual(model.message, "This Apple account isn't linked to WayPoint yet.")
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
        XCTAssertTrue(model.needsSignIn)
    }

    func testProviderSignInRecoversAnExpiredCopy() async throws {
        try savedTrip(); try signedIn(expiresIn: -60)
        let model = acceptingModel()
        await model.start()
        XCTAssertTrue(model.needsSignIn)
        await model.signIn(provider: .apple, idToken: "apple.id.token")
        XCTAssertFalse(model.needsSignIn)
        XCTAssertNil(model.message)
    }

    func testOptionsSurviveALostConnectionAndThePhoneFormIsTheFirstFallback() async throws {
        let log = requests
        let model = model { [googleConfig] path in
            guard log.count(of: path) == 1 else { throw URLError(.notConnectedToInternet) }
            return (200, googleConfig, [:])
        }
        XCTAssertNil(model.signInOptions)
        let first = await model.prepareSignIn()
        XCTAssertTrue(first)
        let second = await model.prepareSignIn()
        XCTAssertFalse(second)
        XCTAssertEqual(model.signInOptions?.googleClientID, "123-abc.apps.googleusercontent.com")
    }

    func testFailedSignInKeepsExpiredCopyOpen() async throws {
        try savedTrip(); try signedIn(expiresIn: -60)
        let model = model { _ in throw URLError(.notConnectedToInternet) }
        await model.start()
        await model.signIn(phone: "+447700900123")
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
        XCTAssertTrue(model.needsSignIn)
    }
}

/// URLProtocol runs off the main actor, so the log guards its own state.
private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(path: String, cookie: String?, body: Data)] = []
    var count: Int { lock.withLock { entries.count } }
    func add(path: String, cookie: String?, body: Data) { lock.withLock { entries.append((path, cookie, body)) } }
    func bodies(for path: String) -> [Data] { lock.withLock { entries.filter { $0.path == path }.map(\.body) } }
    func count(of path: String) -> Int { lock.withLock { entries.filter { $0.path == path }.count } }
    func cookies(for path: String) -> [String?] { lock.withLock { entries.filter { $0.path == path }.map(\.cookie) } }
}

private final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler else { return }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
}
