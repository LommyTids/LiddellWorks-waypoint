import Foundation

/// Send editor-owned fields as a patch, never the entire preserved raw record.
/// This leaves server-only and future fields untouched and uses the Worker's names.
public enum D1RecordPatch {
    public static func make(_ record: ItineraryRecord, previous: [String: JSONValue]?) throws -> [String: JSONValue] {
        var patch: [String: JSONValue] = [record.kind.rawValue + "Id": .string(record.id)]
        let priorRecord: ItineraryRecord?
        if let previous {
            var trip: [String: JSONValue] = ["tripId": .string(record.tripID), "name": .string("Trip"), record.kind.legacyList: .array([.object(previous)])]
            trip["myGrant"] = .object(["role": .string("superuser")])
            var decoded = try LegacyAdapter.decode(JSONEncoder().encode(JSONValue.object(["trips": .array([.object(trip)])]))).first?.records.first
            if record.kind == .transport { decoded?.title = previous["carrier"]?.text ?? "" }
            priorRecord = decoded
        } else { priorRecord = nil }
        func put(_ key: String, _ value: JSONValue, changed: Bool) { if previous == nil || changed { patch[key] = value } }
        func coordinates(_ lat: String, _ lng: String) {
            let changed = priorRecord?.place.latitude != record.place.latitude || priorRecord?.place.longitude != record.place.longitude
            put(lat, record.place.latitude.map(JSONValue.number) ?? .string(""), changed: changed)
            put(lng, record.place.longitude.map(JSONValue.number) ?? .string(""), changed: changed)
        }
        put("notes", .string(record.notes), changed: priorRecord?.notes != record.notes)
        put("companions", .array(record.companions.map(JSONValue.string)), changed: priorRecord?.companions != record.companions)
        switch record.kind {
        case .destination:
            put("name", .string(record.title), changed: priorRecord?.title != record.title)
            put("country", .string(record.place.address), changed: priorRecord?.place.address != record.place.address)
            put("arriveDate", .string(String(record.start.prefix(10))), changed: priorRecord?.start != record.start)
            put("departDate", .string(String(record.end.prefix(10))), changed: priorRecord?.end != record.end)
            put("timezone", .string(record.timeZoneID ?? ""), changed: priorRecord?.timeZoneID != record.timeZoneID)
            coordinates("lat", "lng")
        case .activity:
            put("title", .string(record.title), changed: priorRecord?.title != record.title)
            let datesChanged = priorRecord?.start != record.start || priorRecord?.end != record.end || priorRecord?.allDay != record.allDay
            put("startDate", .string(String(record.start.prefix(10))), changed: datesChanged)
            put("endDate", .string(String(record.end.prefix(10))), changed: datesChanged)
            put("date", .string(String(record.start.prefix(10))), changed: datesChanged)
            put("startTime", .string(record.allDay ? "" : time(record.start)), changed: datesChanged)
            put("endTime", .string(record.allDay ? "" : time(record.end)), changed: datesChanged)
            put("allDay", .bool(record.allDay), changed: datesChanged)
            put("location", .string(record.place.venue), changed: priorRecord?.place.venue != record.place.venue)
            put("address", .string(record.place.address), changed: priorRecord?.place.address != record.place.address)
            coordinates("addressLat", "addressLng")
        case .accommodation:
            put("name", .string(record.title), changed: priorRecord?.title != record.title)
            put("checkIn", .string(record.start), changed: priorRecord?.start != record.start)
            put("checkOut", .string(record.end), changed: priorRecord?.end != record.end)
            put("address", .string(record.place.address), changed: priorRecord?.place.address != record.place.address)
            coordinates("lat", "lng")
        case .transport:
            put("carrier", .string(record.title), changed: priorRecord?.title != record.title)
            put("fromLocation", .string(record.place.address), changed: priorRecord?.place.address != record.place.address)
            put("departDateTime", .string(record.start), changed: priorRecord?.start != record.start)
            put("arriveDateTime", .string(record.end), changed: priorRecord?.end != record.end)
            coordinates("fromLat", "fromLng")
            if previous != nil && (priorRecord?.place.address != record.place.address || priorRecord?.place.latitude != record.place.latitude || priorRecord?.place.longitude != record.place.longitude) {
                for key in ["fromLocationRef", "fromLocationMethod", "fromLocationGranularity", "fromLocationKindLabel"] { patch[key] = .string("") }
                patch["fromLocationStale"] = .bool(false)
            }
            // Arrival has its own coordinates. Do not move them when departure changes.
            for key in ["toLocation", "toLat", "toLng", "mode", "flightNumber", "toLocationRef", "toLocationMethod", "toLocationGranularity", "toLocationStale", "toLocationKindLabel", "fromLocationRef", "fromLocationMethod", "fromLocationGranularity", "fromLocationStale", "fromLocationKindLabel"] {
                if let value = record.raw[key], value != previous?[key] { patch[key] = value }
            }
        }
        if record.kind == .activity || record.kind == .accommodation, let value = record.raw["destinationId"], value != previous?["destinationId"] { patch["destinationId"] = value }
        return patch
    }
    private static func time(_ text: String) -> String { text.split(separator: "T", maxSplits: 1).dropFirst().first.map(String.init) ?? "" }
}
