import XCTest
@testable import WayPointCore

final class LegacyAdapterTests: XCTestCase {
    private func decode(_ json: String) throws -> [TripSnapshot] {
        try LegacyAdapter.decode(Data(json.utf8))
    }

    func testMalformedResponseNeverBecomesAnEmptyTripList() {
        for json in ["", "null", "[]", "{}", "{\"trips\":null}", "{\"trips\":{}}",
                     "{\"error\":\"expired\",\"trips\":[]}", "<html>Login</html>"] {
            XCTAssertThrowsError(try decode(json), json)
        }
    }

    func testExplicitEmptyTripListIsValid() throws {
        XCTAssertEqual(try decode(#"{"trips":[]}"#), [])
    }

    func testNormalizesNumericIdentifiersAndPreservesUnknownFields() throws {
        let trip = try XCTUnwrap(decode(Self.fixture).first)
        XCTAssertEqual(trip.id, "42")
        XCTAssertEqual(trip.role, .user)
        XCTAssertEqual(trip.revision, 7)
        XCTAssertEqual(trip.raw["futureFeature"]?["enabled"], .bool(true))
        XCTAssertEqual(trip.raw["homeCurrency"], .string("GBP"))
        let destination = try XCTUnwrap(trip.records.first { $0.kind == .destination })
        XCTAssertEqual(destination.id, "1")
        XCTAssertEqual(destination.companions, ["99"])
        let activity = try XCTUnwrap(trip.records.first { $0.kind == .activity })
        XCTAssertEqual(activity.id, "2")
        XCTAssertEqual(activity.companions, ["99"])
        XCTAssertEqual(activity.timeZoneID, "Asia/Shanghai")
        XCTAssertEqual(activity.raw["bookingRef"], .string("KEEP-ME"))
        XCTAssertEqual(activity.raw["unexpected"], .array([.string("retained"), .null]))
        XCTAssertEqual(activity.place.venue, "Restaurant name")
        XCTAssertEqual(activity.place.address, "Street address")
        XCTAssertEqual(activity.place.latitude, 31.2)
        XCTAssertEqual(activity.place.longitude, 121.5)
    }

    func testLocalWallClocksAreNotConvertedToUTC() throws {
        let records = try XCTUnwrap(decode(Self.fixture).first).records
        let activity = try XCTUnwrap(records.first { $0.kind == .activity })
        XCTAssertEqual(activity.start, "2026-09-23T18:30")
        XCTAssertEqual(activity.end, "2026-09-23T20:00")
        let transport = try XCTUnwrap(records.first { $0.kind == .transport })
        XCTAssertEqual(transport.start, "2026-09-24T16:00")
        XCTAssertEqual(transport.end, "2026-09-24T08:00")
        XCTAssertNil(transport.timeZoneID)
        XCTAssertEqual(transport.raw["toLng"], .number(-122.4))
    }

    func testAllDayAndLegacySingleDateActivities() throws {
        let trip = try XCTUnwrap(decode(#"{"trips":[{"tripId":"t","activities":[{"activityId":"a","date":"2026-09-23","allDay":"on","startTime":"14:00"}]}]}"#).first)
        let record = try XCTUnwrap(trip.records.first)
        XCTAssertEqual(record.start, "2026-09-23")
        XCTAssertEqual(record.end, "2026-09-23")
        XCTAssertTrue(record.allDay)
    }

    func testAbsentAndUnknownRolesFailClosed() throws {
        for grant in ["{}", #"{"role":"owner"}"#, #"{"role":"SUPERUSER"}"#] {
            let trip = try XCTUnwrap(decode("{\"trips\":[{\"tripId\":\"t\",\"myGrant\":\(grant)}]}").first)
            XCTAssertEqual(trip.role, .viewer)
            XCTAssertFalse(trip.role.canEdit)
        }
    }

    func testOptionalMalformedFieldsAreToleratedButRetained() throws {
        let trip = try XCTUnwrap(decode(#"{"trips":[{"tripId":"t","activities":[{"activityId":"a","title":19,"companions":null,"addressLat":"nope","notes":{"new":1}}]}]}"#).first)
        let record = try XCTUnwrap(trip.records.first)
        XCTAssertEqual(record.title, "Activity")
        XCTAssertEqual(record.companions, [])
        XCTAssertNil(record.place.latitude)
        XCTAssertEqual(record.raw["notes"]?["new"], .number(1))
    }

    func testInvalidIdentityListsAndRevisionsAreRejected() {
        let invalid = [
            #"{"trips":[{}]}"#,
            #"{"trips":[{"tripId":true}]}"#,
            #"{"trips":[{"tripId":9007199254740992}]}"#,
            #"{"trips":[{"tripId":"t","revision":-1}]}"#,
            #"{"trips":[{"tripId":"t","activities":{}}]}"#,
            #"{"trips":[{"tripId":"t","activities":[null]}]}"#,
            #"{"trips":[{"tripId":"t","activities":[{"title":"Missing ID"}]}]}"#
        ]
        for json in invalid { XCTAssertThrowsError(try decode(json), json) }
    }

    func testDuplicateNumericAndStringIDsAreRejected() {
        XCTAssertThrowsError(try decode(#"{"trips":[{"tripId":1},{"tripId":"1"}]}"#))
        XCTAssertThrowsError(try decode(#"{"trips":[{"tripId":"t","activities":[{"activityId":2},{"activityId":"2"}]}]}"#))
    }

    func testRecordIDsMayOverlapAcrossKinds() throws {
        let trips = try decode(#"{"trips":[{"tripId":"t","destinations":[{"destinationId":1}],"activities":[{"activityId":"1"}]}]}"#)
        XCTAssertEqual(trips.first?.records.count, 2)
    }

    func testRawJSONSurvivesPersistenceRoundTrip() throws {
        let trips = try decode(Self.fixture)
        let data = try JSONEncoder().encode(trips)
        XCTAssertEqual(try JSONDecoder().decode([TripSnapshot].self, from: data), trips)
    }

    static let fixture = #"""
    {"trips":[{
      "tripId":42,"name":"China trip","revision":7,"homeCurrency":"GBP",
      "myGrant":{"role":"user","companionId":99},"futureFeature":{"enabled":true},
      "destinations":[{"destinationId":1,"name":"Shanghai","timezone":"Asia/Shanghai","arriveDate":"2026-09-23","departDate":"2026-09-24","companions":[99]}],
      "activities":[{"activityId":"2","destinationId":"1","title":"Dinner","date":"2026-09-23","startTime":"18:30","endTime":"20:00","location":"Restaurant name","address":"Street address","addressLat":"31.2","addressLng":121.5,"companions":["99"],"bookingRef":"KEEP-ME","unexpected":["retained",null]}],
      "transport":[{"transportId":"flight","departDateTime":"2026-09-24T16:00","arriveDateTime":"2026-09-24T08:00","toLng":-122.4}],
      "accommodation":[{"accommodationId":"hotel","name":"Hotel","checkIn":"2026-09-23T15:00","checkOut":"2026-09-24T11:00","destinationId":1}]
    }]}
    """#
}
