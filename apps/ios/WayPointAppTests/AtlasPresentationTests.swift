import XCTest
import UIKit
import WayPointCore
@testable import WayPoint

final class AtlasPresentationTests: XCTestCase {
    @MainActor
    func testWebFontsAreRegisteredInAppBundle() throws {
        for name in ["Fraunces-SemiBold", "WorkSans-Regular", "WorkSansRoman-SemiBold", "IBMPlexMono-Medium"] {
            XCTAssertNotNil(UIFont(name: name, size: 16), "Missing bundled font: \(name)")
        }
        let paths = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UIAppFonts") as? [String])
        XCTAssertEqual(paths.count, 3)
        for path in paths { XCTAssertNotNil(Bundle.main.url(forResource: path, withExtension: nil)) }
    }

    func testDetailAndEditorPermissionUsesCurrentNamedAssignment() {
        let record = ItineraryRecord(id: "plan", tripID: "trip", kind: .activity, title: "Museum", companions: ["42"])
        var trip = TripSnapshot(id: "trip", name: "Trip", role: .user, records: [record],
                                raw: .object(["myGrant": .object(["companionId": .number(42)])]))
        XCTAssertTrue(TripParticipant.canEdit(record, in: trip))
        trip.records[0].companions = ["someone-else"]
        XCTAssertFalse(TripParticipant.canEdit(record, in: trip), "A refresh removing the assignment must revoke editing")
        trip.records = []
        XCTAssertFalse(TripParticipant.canEdit(record, in: trip))
        trip.role = .viewer
        trip.records = [record]
        XCTAssertFalse(TripParticipant.canEdit(record, in: trip))
        trip.role = .admin
        XCTAssertTrue(TripParticipant.canEdit(record, in: trip))
    }
}
