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

    func testDeletionSendsTheConfirmationAndApplesCode() async throws {
        let current = session()
        let client = api(status: 200, body: "{\"status\":\"ok\",\"appleRevoked\":true}") { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/waypoint/api/account/deletion")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "wp_session=\(current.cookieValue)")
            let payload = try? JSONSerialization.jsonObject(with: requestBody(request)) as? [String: String]
            XCTAssertEqual(payload, ["confirm": "DELETE", "appleAuthorizationCode": "apple-code"])
        }
        let revoked = try await client.deleteAccount(session: current, appleAuthorizationCode: "apple-code")
        XCTAssertTrue(revoked)
    }

    func testDeletionWithoutAppleSendsNoCode() async throws {
        let client = api(status: 200, body: "{\"status\":\"ok\",\"appleRevoked\":false}") { request in
            let payload = try? JSONSerialization.jsonObject(with: requestBody(request)) as? [String: String]
            XCTAssertEqual(payload, ["confirm": "DELETE"])
        }
        let revoked = try await client.deleteAccount(session: session(), appleAuthorizationCode: nil)
        XCTAssertFalse(revoked)
    }

    func testDeletionRefusalsShowTheServersReasonInEitherFormat() async throws {
        let plain = api(status: 409, body: "{\"error\":\"This is the site owner's account.\"}")
        do { _ = try await plain.deleteAccount(session: session(), appleAuthorizationCode: nil); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "This is the site owner's account.") }
        let structured = api(status: 409, body: "{\"error\":{\"code\":\"concurrent_change\",\"message\":\"Sharing changed. Try again.\"}}")
        do { _ = try await structured.deleteAccount(session: session(), appleAuthorizationCode: nil); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "Sharing changed. Try again.") }
        let wrongApple = api(status: 403, body: "{\"error\":\"That isn't the Apple ID linked to this account.\"}")
        do { _ = try await wrongApple.deleteAccount(session: session(), appleAuthorizationCode: "code"); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "That isn't the Apple ID linked to this account.") }
    }

    func testDeletionOutagesAreWordedForThePerson() async throws {
        let paused = api(status: 503, body: "{\"error\":{\"code\":\"migration_paused\",\"message\":\"Saving is paused.\"}}")
        do { _ = try await paused.deleteAccount(session: session(), appleAuthorizationCode: nil); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "Saving is paused.") }
        let storage = api(status: 503, body: "{\"error\":{\"code\":\"service_unavailable\",\"message\":\"Retry using the same mutation IDs.\"}}")
        do { _ = try await storage.deleteAccount(session: session(), appleAuthorizationCode: nil); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "Your account has not been deleted. Please try again.") }
    }

    func testAnUnrecognisedDeletionReplyIsNotTreatedAsDone() async throws {
        let client = api(status: 200, body: "{\"status\":\"pending\"}")
        do { _ = try await client.deleteAccount(session: session(), appleAuthorizationCode: nil); XCTFail("Expected failure") }
        catch APIError.invalidResponse { }
    }

    func testDeletionSummaryIgnoresFieldsItDoesNotKnow() async throws {
        let client = api(status: 200, body: "{\"linkedSignIn\":\"apple\",\"appleRevocation\":true,\"blocked\":null,\"tripsErased\":1,\"tripsHandedOver\":2,\"tripsLeft\":3,\"later\":true}")
        let summary = try await client.accountDeletionSummary(session: session())
        XCTAssertTrue(summary.confirmsWithApple)
        XCTAssertEqual([summary.tripsErased, summary.tripsHandedOver, summary.tripsLeft], [1, 2, 3])
    }

    func testAppleIsOnlyAskedWhenTheServerCanUseItsCode() {
        func summary(_ linked: String?, revocation: Bool) -> AccountDeletionSummary {
            AccountDeletionSummary(linkedSignIn: linked, appleRevocation: revocation, blocked: nil,
                                   tripsErased: 0, tripsHandedOver: 0, tripsLeft: 0)
        }
        XCTAssertTrue(summary("apple", revocation: true).confirmsWithApple)
        XCTAssertFalse(summary("apple", revocation: false).confirmsWithApple)
        XCTAssertTrue(summary("apple", revocation: false).isLinkedToApple)
        XCTAssertFalse(summary("google", revocation: true).confirmsWithApple)
        XCTAssertFalse(summary(nil, revocation: true).confirmsWithApple)
    }

    func testConfirmationScreenStatesOnlyWhatApplies() {
        let none = AccountDeletionSummary(linkedSignIn: nil, appleRevocation: false, blocked: nil,
                                          tripsErased: 0, tripsHandedOver: 0, tripsLeft: 0)
        XCTAssertEqual(none.consequences(pendingChanges: 0), [
            "Your account and sign-in are removed for good. This can't be undone.",
            "Saved trips on this device are removed too."])
        let one = AccountDeletionSummary(linkedSignIn: nil, appleRevocation: false, blocked: nil,
                                         tripsErased: 1, tripsHandedOver: 1, tripsLeft: 1)
        XCTAssertEqual(one.consequences(pendingChanges: 1), [
            "Your account and sign-in are removed for good. This can't be undone.",
            "1 trip only you can open will be erased.",
            "1 trip you share with other people stays with them, without your name.",
            "You'll lose access to 1 trip shared with you.",
            "1 change on this device that hasn't synced will be lost.",
            "Saved trips on this device are removed too."])
        let many = AccountDeletionSummary(linkedSignIn: nil, appleRevocation: false, blocked: nil,
                                          tripsErased: 2, tripsHandedOver: 3, tripsLeft: 4)
        XCTAssertEqual(Array(many.consequences(pendingChanges: 5).dropFirst().dropLast()), [
            "2 trips only you can open will be erased.",
            "3 trips you share with other people stay with them, without your name.",
            "You'll lose access to 4 trips shared with you.",
            "5 changes on this device that haven't synced will be lost."])
    }

    func testConfirmationNeedsTheWholeWord() {
        XCTAssertTrue(AccountDeletionSummary.isConfirmed("DELETE"))
        XCTAssertTrue(AccountDeletionSummary.isConfirmed(" delete\n"))
        XCTAssertFalse(AccountDeletionSummary.isConfirmed(""))
        XCTAssertFalse(AccountDeletionSummary.isConfirmed("DELET"))
        XCTAssertFalse(AccountDeletionSummary.isConfirmed("DELETE ACCOUNT"))
    }

    func testRenewedSessionKeepsItsAppleIdentifier() async throws {
        var current = testSession(expiresIn: 3500)
        current.appleUserID = "apple.user"
        let fresh = testSession(expiresIn: 86_400)
        let client = api(status: 200, body: identityBody, headers: ["Set-Cookie": renewalCookie(fresh)])
        let renewed = try await client.whoAmI(session: current).renewed
        XCTAssertEqual(renewed?.appleUserID, "apple.user")
    }

    func testSessionSavedByAnOlderBuildStillOpens() throws {
        let older = try JSONEncoder().encode(session())
        XCTAssertFalse(String(decoding: older, as: UTF8.self).contains("appleUserID"))
        XCTAssertNil(try JSONDecoder().decode(SavedSession.self, from: older).appleUserID)
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

    private func model(appleState: ((String) async -> ASAuthorizationAppleIDProvider.CredentialState?)? = nil,
                       routes: @escaping (String) throws -> (Int, String, [String: String])) -> AppModel {
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
        return AppModel(api: WayPointAPI(configuration: configuration), keychain: keychain, store: store,
                        appleCredentialState: appleState ?? { _ in nil })
    }

    private func savedTrip(account: Account? = nil, id: String = "trip") throws {
        let owner = account ?? self.account
        var state = D1Workspace(account: owner)
        let page = "{\"protocolVersion\":1,\"entities\":[{\"tripId\":\"\(id)\",\"kind\":\"trip\",\"recordId\":\"\(id)\",\"revision\":1,\"operation\":\"upsert\",\"updatedAt\":\"\",\"data\":{\"name\":\"Saved trip\"},\"permission\":{\"role\":\"superuser\",\"companionId\":\"\"}}],\"complete\":true,\"nextCursor\":null,\"syncCursor\":\"cursor\"}"
        try state.publishBootstrap(pages: [JSONDecoder().decode(D1BootstrapPage.self, from: Data(page.utf8))])
        try store.saveD1(state, accountID: owner.id)
    }

    private func signedIn(expiresIn seconds: TimeInterval = 3500, appleUserID: String? = nil) throws {
        // Saved while still in date: a stored session only expires by ageing.
        var session = testSession(expiresIn: seconds)
        session.appleUserID = appleUserID
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

    // MARK: Deleting an account

    private let deleted = "{\"status\":\"ok\",\"appleRevoked\":false}"
    private let deletedAndRevoked = "{\"status\":\"ok\",\"appleRevoked\":true}"

    private func summary(linked: String? = nil) -> AccountDeletionSummary {
        AccountDeletionSummary(linkedSignIn: linked, appleRevocation: linked == "apple", blocked: nil,
                               tripsErased: 1, tripsHandedOver: 0, tripsLeft: 0)
    }

    /// Signed in with a saved trip open, on a server that answers deletion with `deletion`.
    private func openModel(appleUserID: String? = nil,
                           appleState: ((String) async -> ASAuthorizationAppleIDProvider.CredentialState?)? = nil,
                           deletion: @escaping () throws -> (Int, String, [String: String])) async throws -> AppModel {
        try savedTrip(); try signedIn(appleUserID: appleUserID)
        let model = model(appleState: appleState) { [capabilities, emptyChanges] path in
            switch path {
            case "whoami": return (200, identityBody, [:])
            case "v1/sync/capabilities": return (200, capabilities, [:])
            case "v1/sync/changes": return (200, emptyChanges, [:])
            case "account/deletion": return try deletion()
            default: throw URLError(.badServerResponse)
            }
        }
        await model.start()
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
        return model
    }

    func testDeletingAnAccountRemovesItsCopiesAndNoOneElses() async throws {
        let other = Account(id: "other_account", username: "Other")
        try savedTrip(account: other)
        try store.save(LocalWorkspace(account: account))
        let reply = deleted
        let model = try await openModel { (200, reply, [:]) }
        XCTAssertTrue(model.canDeleteAccount)

        try await model.deleteAccount(summary: summary())

        XCTAssertNil(try keychain.read())
        XCTAssertNil(try reloadedState())
        XCTAssertNil(try store.load(accountID: account.id))
        XCTAssertNil(model.workspace)
        XCTAssertFalse(model.canDeleteAccount)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.notice, "Your WayPoint account has been deleted.")
        XCTAssertNotNil(try store.loadD1(accountID: other.id, as: D1Workspace.self))
    }

    func testDeletingWithNoSavedCopyIsNotAnError() throws {
        XCTAssertNoThrow(try store.deleteD1(accountID: "never_saved"))
    }

    func testFailedDeletionLosesNothing() async throws {
        let model = try await openModel { throw URLError(.notConnectedToInternet) }
        do { try await model.deleteAccount(summary: summary()); XCTFail("Expected failure") } catch { }
        XCTAssertNotNil(try keychain.read())
        XCTAssertNotNil(try reloadedState())
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
        XCTAssertNil(model.notice)
        XCTAssertTrue(model.canDeleteAccount)
    }

    func testTryingAgainAfterALostReplyFinishes() async throws {
        let log = requests, reply = deleted
        let model = try await openModel {
            if log.count(of: "account/deletion") == 1 { throw URLError(.networkConnectionLost) }
            return (200, reply, [:])
        }
        do { try await model.deleteAccount(summary: summary()); XCTFail("Expected failure") } catch { }
        try await model.deleteAccount(summary: summary())
        XCTAssertNil(try keychain.read())
        XCTAssertNil(try reloadedState())
        XCTAssertEqual(model.notice, "Your WayPoint account has been deleted.")
    }

    func testRefusedDeletionShowsWhyAndLosesNothing() async throws {
        let model = try await openModel { (409, "{\"error\":\"This is the site owner's account.\"}", [:]) }
        do { try await model.deleteAccount(summary: summary()); XCTFail("Expected refusal") }
        catch APIError.server(let message) { XCTAssertEqual(message, "This is the site owner's account.") }
        XCTAssertNotNil(try keychain.read())
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
    }

    func testAnEndedSessionKeepsDraftsBecauseTheAccountMayStillExist() async throws {
        let model = try await openModel { (401, "{\"error\":\"Please log in.\"}", [:]) }
        try await model.deleteAccount(summary: summary())
        XCTAssertNil(try keychain.read())
        XCTAssertNil(model.workspace)
        XCTAssertNotNil(try reloadedState())
        XCTAssertNil(model.notice)
        XCTAssertNotNil(model.message)
    }

    func testAppleCodeIsSentAndAFinishedRevocationNeedsNoFurtherStep() async throws {
        let reply = deletedAndRevoked
        let model = try await openModel { (200, reply, [:]) }
        try await model.deleteAccount(summary: summary(linked: "apple"), appleAuthorizationCode: "apple-code")
        let sent = try XCTUnwrap(requests.bodies(for: "account/deletion").first)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: sent) as? [String: String],
                       ["confirm": "DELETE", "appleAuthorizationCode": "apple-code"])
        XCTAssertEqual(model.notice, "Your WayPoint account has been deleted.")
    }

    func testAppleLinkThatRemainsGetsTheManualStep() async throws {
        let reply = deleted
        let model = try await openModel { (200, reply, [:]) }
        try await model.deleteAccount(summary: summary(linked: "apple"))
        XCTAssertEqual(model.notice, "Your WayPoint account has been deleted. To finish, open Settings, tap your name, then Sign-In & Security, then Sign in with Apple, and remove WayPoint.")
    }

    func testOtherSignInsNeverGetTheAppleStep() async throws {
        let reply = deleted
        let model = try await openModel { (200, reply, [:]) }
        try await model.deleteAccount(summary: summary(linked: "google"))
        XCTAssertEqual(model.notice, "Your WayPoint account has been deleted.")
    }

    func testTheDemoHasNoAccountToDelete() async throws {
        let model = model { _ in throw URLError(.badServerResponse) }
        model.enterDemo()
        XCTAssertFalse(model.canDeleteAccount)
        do { try await model.deleteAccount(summary: summary()); XCTFail("Expected refusal") } catch { }
        do { _ = try await model.accountDeletionSummary(); XCTFail("Expected refusal") } catch { }
        XCTAssertEqual(requests.count, 0)
        XCTAssertNotNil(model.workspace)
    }

    func testAnExpiredSessionMustSignInBeforeDeleting() async throws {
        try savedTrip(); try signedIn(expiresIn: -60)
        let model = model { _ in throw URLError(.notConnectedToInternet) }
        await model.start()
        XCTAssertTrue(model.needsSignIn)
        XCTAssertFalse(model.canDeleteAccount)
        do { try await model.deleteAccount(summary: summary()); XCTFail("Expected refusal") } catch { }
        XCTAssertEqual(requests.count(of: "account/deletion"), 0)
        XCTAssertEqual(model.trips.map(\.name), ["Saved trip"])
    }

    func testSigningInAgainClearsTheDeletionNotice() async throws {
        let reply = deleted
        let model = try await openModel { (200, reply, [:]) }
        try await model.deleteAccount(summary: summary())
        XCTAssertNotNil(model.notice)
        model.enterDemo()
        XCTAssertNil(model.notice)
    }

    // MARK: Apple's own view of the link

    func testAppleSignInKeepsApplesIdentifierOutOfTheRequest() async throws {
        let model = acceptingModel()
        await model.signIn(provider: .apple, idToken: "apple.id.token", appleUserID: "apple.user")
        XCTAssertEqual(try keychain.read()?.appleUserID, "apple.user")
        let sent = try XCTUnwrap(requests.bodies(for: "login/identity").first)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: sent) as? [String: String],
                       ["provider": "apple", "idToken": "apple.id.token"])
    }

    func testRevokedAppleLinkClosesTheSessionAtLaunchAndKeepsDrafts() async throws {
        try savedTrip(); try signedIn(appleUserID: "apple.user")
        var asked: [String] = []
        let model = model(appleState: { asked.append($0); return .revoked }) { _ in throw URLError(.badServerResponse) }
        await model.start()
        XCTAssertEqual(asked, ["apple.user"])
        XCTAssertNil(model.workspace)
        XCTAssertNil(try keychain.read())
        XCTAssertNotNil(try reloadedState())
        XCTAssertEqual(requests.count, 0)
    }

    func testOnlyADefiniteRevocationClosesTheSession() async throws {
        let states: [ASAuthorizationAppleIDProvider.CredentialState?] = [.authorized, .notFound, .transferred, nil]
        for state in states {
            let reply = deleted
            let model = try await openModel(appleUserID: "apple.user", appleState: { _ in state }) { (200, reply, [:]) }
            XCTAssertNotNil(model.workspace)
            XCTAssertNotNil(try keychain.read())
        }
    }

    func testSessionsWithoutAnAppleIdentifierAreNotChecked() async throws {
        var asked = false
        let reply = deleted
        _ = try await openModel(appleState: { _ in asked = true; return .revoked }) { (200, reply, [:]) }
        XCTAssertFalse(asked)
    }

    func testRevocationWhileRunningClosesTheSession() async throws {
        var state = ASAuthorizationAppleIDProvider.CredentialState.authorized
        let reply = deleted
        let model = try await openModel(appleUserID: "apple.user", appleState: { _ in state }) { (200, reply, [:]) }
        state = .revoked
        NotificationCenter.default.post(name: ASAuthorizationAppleIDProvider.credentialRevokedNotification, object: nil)
        for _ in 0..<200 where model.workspace != nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNil(model.workspace)
        XCTAssertNil(try keychain.read())
    }

    func testApplesNoticeDuringDeletionDoesNotInterruptIt() async throws {
        let reply = deletedAndRevoked
        let revoked = ManagedFlag()
        let model = try await openModel(appleUserID: "apple.user", appleState: { _ in revoked.isSet ? .revoked : .authorized }) {
            revoked.set()
            NotificationCenter.default.post(name: ASAuthorizationAppleIDProvider.credentialRevokedNotification, object: nil)
            return (200, reply, [:])
        }
        try await model.deleteAccount(summary: summary(linked: "apple"), appleAuthorizationCode: "apple-code")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(model.notice, "Your WayPoint account has been deleted.")
        XCTAssertNil(model.message)
    }
}

private final class ManagedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
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
