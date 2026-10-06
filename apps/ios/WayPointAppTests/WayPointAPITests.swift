import XCTest
import Foundation
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

    private func session() -> SavedSession {
        let milliseconds = Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000
        let claims = Data("{\"uid\":\"test_account\",\"exp\":\(milliseconds)}".utf8)
            .base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return SavedSession(account: Account(id: "test_account", username: "Tester"),
                            cookieValue: claims + ".testsignature", expiresAt: Date().addingTimeInterval(3500))
    }

    func testLoginAcceptsHostOnlyWorkerCookie() async throws {
        let cookie = session().cookieValue
        let client = api(status: 200,
                         body: "{\"status\":\"ok\",\"id\":\"test_account\",\"username\":\"Tester\"}",
                         headers: ["Set-Cookie": "wp_session=\(cookie); Path=/WayPoint; Secure; HttpOnly; SameSite=Lax; Max-Age=604800"]) { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.scheme, "https")
            XCTAssertEqual(request.url?.host, "liddellworks.com")
            XCTAssertEqual(request.url?.path, "/WayPoint/api/login")
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
                         headers: ["Set-Cookie": "wp_session=\(cookie); Path=/WayPoint; Secure; HttpOnly; SameSite=Lax; Max-Age=604800"]) { request in
            // URLSession may convert httpBody into a stream before URLProtocol.
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
            let payload = try? JSONSerialization.jsonObject(with: body) as? [String: String]
            XCTAssertEqual(payload, ["phone": "+44 7700 900123"])
            XCTAssertEqual(request.url?.path, "/WayPoint/api/login")
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
            XCTAssertEqual(request.url?.path, "/WayPoint/api/v1/sync/bootstrap")
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

private final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler else { return }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
