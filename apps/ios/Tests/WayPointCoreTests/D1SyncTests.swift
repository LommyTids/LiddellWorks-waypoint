import XCTest
@testable import WayPointCore

final class D1SyncTests: XCTestCase {
    let account = Account(id: "owner", username: "Owner")
    func trip(role: TripRole = .superuser) -> D1Entity {
        D1Entity(tripId: "trip", kind: .trip, recordId: "trip", revision: 7,
                 data: ["name": .string("Trip")], permission: D1Permission(role: role, companionId: "person"))
    }
    func activity(id: String = "item", revision: Int = 2, title: String = "Walk") -> D1Entity {
        D1Entity(tripId: "trip", kind: .activity, recordId: id, revision: revision,
                 data: ["activityId": .string(id), "title": .string(title), "companions": .array([.string("person")]), "bookingRef": .string("KEEP"), "futureExtension": .string("PRESERVE")])
    }
    func workspace(role: TripRole = .superuser) throws -> D1Workspace {
        var value = D1Workspace(account: account)
        try value.publishBootstrap(pages: [D1BootstrapPage(protocolVersion: 1, entities: [trip(role: role), activity()], complete: true, nextCursor: nil, syncCursor: "signed-cursor")])
        return value
    }
    func edited(_ workspace: D1Workspace, title: String = "New walk") throws -> ItineraryRecord {
        var record = try XCTUnwrap(workspace.presentationTrips().first?.records.first)
        record.title = title; return record
    }
    func applied(_ mutation: D1Mutation, duplicate: Bool = false) -> D1MutationResponse {
        D1MutationResponse(protocolVersion: 1, results: [D1MutationResult(mutationId: mutation.mutationId, status: "applied", tripId: mutation.tripId, kind: mutation.kind, recordId: mutation.recordId, revision: mutation.baseRevision + 1, duplicate: duplicate, error: nil)])
    }
    func testRecordRevisionAndPatchPreserveUnknownFields() throws {
        var state = try workspace()
        try state.stage(edited(state))
        let mutation = try XCTUnwrap(state.submitNext())
        XCTAssertEqual(mutation.baseRevision, 2) // Trip revision is 7, not the record's revision.
        XCTAssertEqual(mutation.operation, .update)
        XCTAssertNil(mutation.data?["bookingRef"])
        XCTAssertNil(mutation.data?["futureExtension"])
        XCTAssertEqual(mutation.data?["title"], .string("New walk"))
        try state.apply(applied(mutation))
        let updated = try XCTUnwrap(state.entities.first { $0.kind == .activity })
        XCTAssertEqual(updated.revision, 3)
        XCTAssertEqual(updated.data?["futureExtension"], .string("PRESERVE"))
        XCTAssertTrue(state.outbox.isEmpty)
    }
    func testSubmittedMutationBodySurvivesPersistenceAndCannotBeCoalesced() throws {
        var state = try workspace()
        try state.stage(edited(state))
        let mutation = try XCTUnwrap(state.submitNext())
        var restored = try JSONDecoder().decode(D1Workspace.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(try restored.submitNext(), mutation)
        XCTAssertThrowsError(try restored.stage(edited(restored, title: "Later edit")))
        XCTAssertEqual(try restored.submitNext(), mutation)
        try restored.apply(applied(mutation, duplicate: true))
        XCTAssertTrue(restored.outbox.isEmpty)
    }
    func testUnrelatedRecordChangeDoesNotConflictAndSameRecordDoes() throws {
        var state = try workspace(); try state.stage(edited(state))
        try state.applyChanges(D1ChangesPage(protocolVersion: 1, entities: [activity(id: "other", revision: 4)], hasMore: false, cursor: "next"))
        XCTAssertEqual(state.outbox.first?.status, .queued)
        try state.applyChanges(D1ChangesPage(protocolVersion: 1, entities: [activity(revision: 3, title: "Remote")], hasMore: false, cursor: "next2"))
        XCTAssertEqual(state.outbox.first?.status, .conflict)
        XCTAssertEqual(try state.presentationTrips().first?.records.first { $0.id == "item" }?.title, "New walk")
        let originalID = try XCTUnwrap(state.outbox.first?.id)
        try state.reapply(id: originalID)
        XCTAssertNotEqual(state.outbox.first?.id, originalID)
        XCTAssertEqual(state.outbox.first?.mutation.baseRevision, 3)
    }
    func testBootstrapMustBeCompleteAndReplacementRevokesDrafts() throws {
        var state = try workspace(); try state.stage(edited(state)); let old = state
        XCTAssertThrowsError(try state.publishBootstrap(pages: [D1BootstrapPage(protocolVersion: 1, entities: [trip()], complete: false, nextCursor: "page2", syncCursor: nil)]))
        XCTAssertEqual(state, old)
        state.invalidateAuthorization()
        XCTAssertEqual(try state.presentationTrips(), [])
        XCTAssertEqual(state.outbox.count, 1)
        XCTAssertThrowsError(try state.submitNext())
        try state.publishBootstrap(pages: [D1BootstrapPage(protocolVersion: 1, entities: [], complete: true, nextCursor: nil, syncCursor: "new")])
        XCTAssertEqual(state.outbox.first?.status, .quarantined)
        XCTAssertTrue(try state.presentationTrips().isEmpty)
    }
    func testPermissionNarrowingNeverOverlaysForbiddenDraft() throws {
        var state = try workspace(); try state.stage(edited(state))
        try state.publishBootstrap(pages: [D1BootstrapPage(protocolVersion: 1, entities: [trip(role: .viewer), activity()], complete: true, nextCursor: nil, syncCursor: "narrow")])
        XCTAssertEqual(state.outbox.first?.status, .quarantined)
        XCTAssertEqual(try state.presentationTrips().first?.records.first?.title, "Walk")
    }
    func testScopedUserCannotCreateDeleteOrChangeTags() throws {
        var state = try workspace(role: .user)
        var record = try edited(state)
        try state.stage(record)
        record.companions = []
        XCTAssertThrowsError(try state.stage(record))
        XCTAssertThrowsError(try state.remove(record))
        record.id = "new-record"
        XCTAssertThrowsError(try state.stage(record))
    }
    func testLocalCreateCancellationAndTripDependencyOrdering() throws {
        var state = try workspace()
        let id = try state.createTrip(name: "Offline holiday")
        let record = ItineraryRecord(id: "new-activity", tripID: id, kind: .activity, title: "Visit")
        try state.stage(record)
        let first = try XCTUnwrap(state.submitNext())
        XCTAssertEqual(first.kind, .trip)
        try state.apply(applied(first))
        let second = try XCTUnwrap(state.submitNext())
        XCTAssertEqual(second.kind, .activity)
        XCTAssertEqual(second.baseRevision, 0)
        XCTAssertEqual(second.operation, .create)
        try state.apply(applied(second))
        let secondRecord = ItineraryRecord(id: "unsent", tripID: id, kind: .activity, title: "Cancel")
        try state.stage(secondRecord); try state.remove(secondRecord)
        XCTAssertTrue(state.outbox.isEmpty)
    }
    func testMutationEnvelopeAndDeletionOmitData() throws {
        let mutation = D1Mutation(tripId: "trip", kind: .activity, recordId: "item", operation: .delete, baseRevision: 2)
        let root = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(D1MutationRequest(mutations: [mutation])))
        XCTAssertEqual(root["protocolVersion"], .number(1))
        guard case .array(let mutations)? = root["mutations"] else { return XCTFail("Missing mutations") }
        XCTAssertNil(mutations.first?["data"])
    }
    func testActivityDatesAreLocalAndTransportArrivalIsIndependent() throws {
        var state = try workspace()
        var activityRecord = try edited(state)
        activityRecord.start = "2026-10-04T15:30"; activityRecord.end = "2026-10-04T17:00"
        try state.stage(activityRecord)
        let patch = try XCTUnwrap(state.outbox.first?.mutation.data)
        XCTAssertEqual(patch["startDate"], .string("2026-10-04"))
        XCTAssertEqual(patch["startTime"], .string("15:30"))
        let raw: [String: JSONValue] = ["transportId": .string("plane"), "carrier": .string("United"), "flightNumber": .string("123"), "fromLocation": .string("London"), "toLocation": .string("Tokyo"), "toLat": .number(35), "toLng": .number(139)]
        let record = ItineraryRecord(id: "plane", tripID: "trip", kind: .transport, title: "United", place: Place(address: "Paris", latitude: 48, longitude: 2), raw: .object(raw))
        let transport = try D1RecordPatch.make(record, previous: raw)
        XCTAssertNil(transport["toLat"]); XCTAssertNil(transport["toLng"]); XCTAssertNil(transport["carrier"])
        XCTAssertEqual(transport["fromLat"], .number(48))
        XCTAssertEqual(transport["fromLocationRef"], .string(""))
    }
    func testDuplicateReceiptDoesNotOverwriteAlreadyDownloadedCanonicalData() throws {
        var state = try workspace(); try state.stage(edited(state))
        let mutation = try XCTUnwrap(state.submitNext())
        try state.applyChanges(D1ChangesPage(protocolVersion: 1, entities: [activity(revision: 3, title: "Canonical server title")], hasMore: false, cursor: "advanced"))
        try state.apply(applied(mutation, duplicate: true))
        XCTAssertEqual(state.entities.first { $0.kind == .activity }?.data?["title"], .string("Canonical server title"))
        XCTAssertTrue(state.outbox.isEmpty)
    }
    func testSubmittedRevokedDraftIsRetainedButCannotRenderOrReplay() throws {
        var state = try workspace(); try state.stage(edited(state))
        let mutation = try XCTUnwrap(state.submitNext())
        try state.publishBootstrap(pages: [D1BootstrapPage(protocolVersion: 1, entities: [], complete: true, nextCursor: nil, syncCursor: "revoked")])
        XCTAssertEqual(state.outbox.first?.mutation, mutation)
        XCTAssertEqual(state.outbox.first?.isQuarantined, true)
        XCTAssertTrue(try state.presentationTrips().isEmpty)
        XCTAssertNil(try state.submitNext())
        XCTAssertNil(try state.presentationWorkspace().mutations.first?.record)
    }
    func testAbsentSubmittedTripCreateReceiptDoesNotRestoreOwnedCache() throws {
        var state = try workspace()
        let tripID = try state.createTrip(name: "New trip")
        try state.stage(ItineraryRecord(id: "child", tripID: tripID, kind: .activity, title: "Visit"))
        let mutation = try XCTUnwrap(state.submitNext())
        try state.publishBootstrap(pages: [D1BootstrapPage(protocolVersion: 1, entities: [], complete: true, nextCursor: nil, syncCursor: "new-snapshot")])
        XCTAssertEqual(try state.submitNext(), mutation) // exact receipt reconciliation only
        try state.apply(applied(mutation, duplicate: true))
        XCTAssertTrue(try state.presentationTrips().isEmpty)
        XCTAssertNil(try state.submitNext()) // children await authorized trip snapshot/review
        XCTAssertEqual(state.outbox.first?.status, .quarantined)
    }

}
