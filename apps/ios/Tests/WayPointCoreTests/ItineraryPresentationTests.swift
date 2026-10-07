import XCTest
@testable import WayPointCore

final class ItineraryPresentationTests: XCTestCase {
    func testMultiplePeopleMatchAnyOnceAndKeepUnassignedPlans() {
        let records = [record("shared", people: ["alex", "sam"]), record("alex", people: ["alex"]),
                       record("other", people: ["lee"]), record("unassigned", people: [])]
        let trip = TripSnapshot(id: "trip", name: "Meetup", role: .admin, records: records)
        XCTAssertEqual(ItineraryPresentation.records(in: trip, selectedPeople: ["alex", "sam"]).map(\.id),
                       ["shared", "alex", "unassigned"])
        XCTAssertEqual(trip.records, records, "A view filter must not rewrite assignments")
        XCTAssertEqual(ItineraryPresentation.records(in: trip, selectedPeople: []).count, 4)
    }

    func testScopedAccountsKeepOnlyTheirAuthorizedSnapshot() {
        for role in [TripRole.user, .viewer] {
            let trip = TripSnapshot(id: "trip", name: "Meetup", role: role,
                                    records: [record("authorized", people: ["sam"])])
            XCTAssertEqual(ItineraryPresentation.records(in: trip, selectedPeople: ["lee"]).map(\.id), ["authorized"])
        }
    }

    private func record(_ id: String, people: [String]) -> ItineraryRecord {
        ItineraryRecord(id: id, tripID: "trip", kind: .activity, title: id, companions: people)
    }
}
