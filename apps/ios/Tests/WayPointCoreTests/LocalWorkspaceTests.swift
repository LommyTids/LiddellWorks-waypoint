import XCTest
@testable import WayPointCore

final class LocalWorkspaceTests: XCTestCase {
    private let account = Account(id: "account-1", username: "Traveller")

    private func record(id: String = "a", kind: RecordKind = .activity) -> ItineraryRecord {
        ItineraryRecord(id: id, tripID: "trip-1", kind: kind, title: "Original",
                        start: "2026-09-23T09:00", end: "2026-09-23T10:00",
                        companions: ["person-1"], raw: .object(["bookingRef": .string("KEEP")]))
    }

    private func snapshot(revision: Int = 7, role: TripRole = .admin,
                          records: [ItineraryRecord]? = nil) -> TripSnapshot {
        TripSnapshot(id: "trip-1", name: "Trip", revision: revision, role: role,
                     records: records ?? [record()],
                     raw: .object(["myGrant": .object(["role": .string(role.rawValue),
                                                       "companionId": .string("person-1")])]))
    }

    private func workspace(role: TripRole = .admin) -> LocalWorkspace {
        LocalWorkspace(account: account, trips: [snapshot(role: role)])
    }

    func testRepeatedEditsCoalesceWithoutLosingIdentityOrOriginalRevision() throws {
        var store = workspace()
        var edit = record()
        edit.title = "First draft"
        edit.raw = .object([:])
        try store.stage(edit)
        let first = try XCTUnwrap(store.mutations.first)
        edit.title = "Second draft"
        try store.stage(edit)
        XCTAssertEqual(store.mutations.count, 1)
        XCTAssertEqual(store.mutations[0].id, first.id)
        XCTAssertEqual(store.mutations[0].createdAt, first.createdAt)
        XCTAssertEqual(store.mutations[0].baseRevision, 7)
        XCTAssertEqual(store.mutations[0].record?.title, "Second draft")
        XCTAssertEqual(store.trips[0].records[0].raw["bookingRef"], .string("KEEP"))
    }

    func testNewDraftThenDeleteCancelsQueueEntry() throws {
        var store = workspace()
        let new = record(id: "new")
        try store.stage(new)
        XCTAssertEqual(store.mutations.first?.isLocalCreation, true)
        try store.remove(new)
        XCTAssertTrue(store.mutations.isEmpty)
        XCTAssertEqual(store.trips[0].records.map(\.id), ["a"])
    }

    func testNewDraftSurvivesPersistenceAndRefreshBeforeCancellation() throws {
        var store = workspace()
        let new = record(id: "new")
        try store.stage(new)
        store = try JSONDecoder().decode(LocalWorkspace.self, from: JSONEncoder().encode(store))
        try store.refresh(with: [snapshot()])
        XCTAssertEqual(store.trips[0].records.count, 2)
        try store.remove(new)
        XCTAssertTrue(store.mutations.isEmpty)
    }

    func testCreationThatAppearsOnServerIsNotSilentlyCancelledOnDelete() throws {
        var store = workspace()
        let new = record(id: "new")
        try store.stage(new)
        try store.refresh(with: [snapshot(revision: 8, records: [record(), new])])
        XCTAssertEqual(store.mutations.first?.isLocalCreation, false)
        try store.remove(new)
        XCTAssertEqual(store.mutations.count, 1)
        XCTAssertEqual(store.mutations.first?.operation, .delete)
        XCTAssertEqual(store.mutations.first?.status, .conflict)
    }

    func testEditingExistingRecordThenDeletingKeepsOneDeletion() throws {
        var store = workspace()
        var edit = record()
        edit.title = "Draft"
        try store.stage(edit)
        try store.remove(edit)
        XCTAssertTrue(store.trips[0].records.isEmpty)
        XCTAssertEqual(store.mutations.count, 1)
        XCTAssertEqual(store.mutations[0].operation, .delete)
        XCTAssertNil(store.mutations[0].record)
        XCTAssertEqual(store.mutations[0].baseRevision, 7)
        try store.refresh(with: [snapshot()])
        XCTAssertTrue(store.trips[0].records.isEmpty)
    }

    func testRefreshRetainsDraftAndAddsUntouchedServerItems() throws {
        var store = workspace()
        var edit = record()
        edit.title = "Draft"
        try store.stage(edit)
        let refreshedAt = Date(timeIntervalSince1970: 1_000)
        try store.refresh(with: [snapshot(records: [record(), record(id: "other")])], at: refreshedAt)
        XCTAssertEqual(store.trips[0].records.map(\.title), ["Draft", "Original"])
        XCTAssertEqual(store.mutations.first?.status, .queued)
        XCTAssertEqual(store.lastRefresh, refreshedAt)
    }

    func testChangedRevisionFlagsConflictAndFurtherEditsDoNotRebase() throws {
        var store = workspace()
        var edit = record()
        edit.title = "My draft"
        try store.stage(edit)
        try store.refresh(with: [snapshot(revision: 8)])
        XCTAssertEqual(store.trips[0].records[0].title, "My draft")
        XCTAssertEqual(store.mutations[0].status, .conflict)
        XCTAssertNotNil(store.mutations[0].message)
        edit.title = "Revised draft"
        try store.stage(edit)
        XCTAssertEqual(store.mutations[0].baseRevision, 7)
        XCTAssertEqual(store.mutations[0].status, .conflict)
    }

    func testRepeatedRefreshCannotSilentlyResolveConflict() throws {
        var store = workspace()
        try store.stage(record())
        try store.refresh(with: [snapshot(revision: 8)])
        try store.refresh(with: [snapshot(revision: 8)])
        XCTAssertEqual(store.mutations[0].status, .conflict)
        // The KV source can return a stale revision. That is not resolution.
        try store.refresh(with: [snapshot(revision: 7)])
        XCTAssertEqual(store.mutations[0].status, .conflict)
    }

    func testViewerDowngradeBlocksDraftWithoutApplyingIt() throws {
        var store = workspace()
        var edit = record()
        edit.title = "Private draft"
        try store.stage(edit)
        try store.refresh(with: [snapshot(role: .viewer)])
        XCTAssertEqual(store.mutations[0].status, .blocked)
        XCTAssertEqual(store.mutations[0].record?.title, "Private draft")
        XCTAssertEqual(store.trips[0].records[0].title, "Original")
        let before = store
        XCTAssertThrowsError(try store.stage(edit)) { XCTAssertEqual($0 as? LocalWorkspaceError, .readOnly) }
        XCTAssertThrowsError(try store.remove(record())) { XCTAssertEqual($0 as? LocalWorkspaceError, .readOnly) }
        XCTAssertEqual(store, before)
    }

    func testScopedDowngradePurgesNowHiddenDrafts() throws {
        var store = workspace()
        try store.stage(record())
        try store.stage(record(id: "new"))
        try store.refresh(with: [snapshot(role: .user, records: [])])
        XCTAssertTrue(store.trips[0].records.isEmpty)
        XCTAssertTrue(store.mutations.isEmpty)
    }

    func testScopedDowngradeBlocksExistingDeleteAndParticipantChange() throws {
        var deletion = workspace()
        try deletion.remove(record())
        try deletion.refresh(with: [snapshot(role: .user)])
        XCTAssertEqual(deletion.mutations[0].status, .blocked)
        XCTAssertEqual(deletion.trips[0].records.count, 1)

        var retagging = workspace()
        var edit = record()
        edit.companions.append("person-2")
        try retagging.stage(edit)
        try retagging.refresh(with: [snapshot(role: .user)])
        XCTAssertEqual(retagging.mutations[0].status, .blocked)
        XCTAssertEqual(retagging.trips[0].records[0].companions, ["person-1"])
    }

    func testScopedUserCanEditTaggedExistingRecordOnly() throws {
        var store = workspace(role: .user)
        var edit = record()
        edit.title = "Allowed"
        try store.stage(edit)
        let before = store
        XCTAssertThrowsError(try store.stage(record(id: "new"))) {
            XCTAssertEqual($0 as? LocalWorkspaceError, .scopedPermission)
        }
        XCTAssertThrowsError(try store.remove(edit)) {
            XCTAssertEqual($0 as? LocalWorkspaceError, .scopedPermission)
        }
        edit.companions.append("person-2")
        XCTAssertThrowsError(try store.stage(edit)) {
            XCTAssertEqual($0 as? LocalWorkspaceError, .scopedPermission)
        }
        XCTAssertEqual(store, before)
    }

    func testScopedUserCannotEditUntaggedOrMissingGrantRecord() {
        var store = workspace(role: .user)
        store.trips[0].records[0].companions = ["someone-else"]
        XCTAssertThrowsError(try store.stage(store.trips[0].records[0]))
        store.trips[0].raw = .object([:])
        XCTAssertThrowsError(try store.stage(record()))
        XCTAssertTrue(store.mutations.isEmpty)
    }

    func testRevokedTripPurgesBothCacheAndDrafts() throws {
        var store = workspace()
        try store.stage(record())
        try store.refresh(with: [])
        XCTAssertTrue(store.trips.isEmpty)
        XCTAssertTrue(store.mutations.isEmpty)
    }

    func testAccountMismatchRejectsEveryMutationAtomically() throws {
        var store = workspace()
        try store.stage(record())
        store.account.id = "different-account"
        let before = store
        XCTAssertThrowsError(try store.stage(record())) { XCTAssertEqual($0 as? LocalWorkspaceError, .accountMismatch) }
        XCTAssertThrowsError(try store.remove(record())) { XCTAssertEqual($0 as? LocalWorkspaceError, .accountMismatch) }
        XCTAssertThrowsError(try store.refresh(with: [])) { XCTAssertEqual($0 as? LocalWorkspaceError, .accountMismatch) }
        XCTAssertEqual(store, before)
    }

    func testInvalidRefreshDoesNotPartiallyReplaceCache() throws {
        var store = workspace()
        try store.stage(record())
        let before = store
        XCTAssertThrowsError(try store.refresh(with: [snapshot(), snapshot()]))
        var invalid = snapshot()
        invalid.records[0].tripID = "wrong-trip"
        XCTAssertThrowsError(try store.refresh(with: [invalid]))
        XCTAssertEqual(store, before)
    }

    func testQueueSeparatesSameIDsAcrossKinds() throws {
        var store = workspace()
        try store.stage(record())
        try store.stage(record(kind: .destination))
        XCTAssertEqual(store.mutations.count, 2)
        XCTAssertEqual(store.trips[0].records.count, 2)
    }

    func testInvalidDateAndCoordinatesLeaveStoreUnchanged() {
        var store = workspace()
        let before = store
        for date in ["2026-02-30", "2026-13-01", "2026-09-23T25:00", "2026-09-23T09:00Z"] {
            var edit = record()
            edit.start = date
            XCTAssertThrowsError(try store.stage(edit))
        }
        var edit = record()
        edit.place.latitude = 91
        edit.place.longitude = 0
        XCTAssertThrowsError(try store.stage(edit))
        edit.place.latitude = 30
        edit.place.longitude = nil
        XCTAssertThrowsError(try store.stage(edit))
        XCTAssertEqual(store, before)
    }

    func testTransportCanArriveAtEarlierWallClockTimeAcrossZones() throws {
        var store = workspace()
        var flight = record(id: "flight", kind: .transport)
        flight.start = "2026-09-23T16:00"
        flight.end = "2026-09-23T08:00"
        try store.stage(flight)
        XCTAssertEqual(store.mutations.first?.record?.end, flight.end)
    }

    func testOldQueueWithoutCreationFlagRemainsDecodableAndConservative() throws {
        let mutation = PendingMutation(accountID: account.id, tripID: "trip-1", recordID: "a",
                                       kind: .activity, operation: .upsert, baseRevision: 7,
                                       record: record())
        let encoded = try JSONEncoder().encode(mutation)
        let decoded = try JSONDecoder().decode(PendingMutation.self, from: encoded)
        XCTAssertNil(decoded.isLocalCreation)
        var store = LocalWorkspace(account: account, trips: [snapshot()], mutations: [decoded])
        try store.remove(record())
        XCTAssertEqual(store.mutations.first?.operation, .delete)
    }
}
