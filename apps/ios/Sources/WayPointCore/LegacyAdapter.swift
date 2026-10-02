import Foundation

public enum LegacyAdapterError: Error, LocalizedError, Equatable {
    case invalidResponse
    case invalidTrip
    case invalidRecord(String)
    case duplicateIdentifier(String)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: return "The server did not return a valid trip list. Your saved copy has not been replaced."
        case .invalidTrip: return "The server returned a trip with an invalid identifier or revision."
        case .invalidRecord(let kind): return "The server returned an invalid \(kind.lowercased()) record."
        case .duplicateIdentifier(let id): return "The server returned a duplicate identifier (\(id))."
        }
    }
}

/// Reads the existing GET /WayPoint/api/data format. This is intentionally not a
/// legacy encoder: sending a partial trip snapshot to POST /data is unsafe.
public enum LegacyAdapter {
    public static func decode(_ data: Data) throws -> [TripSnapshot] {
        let root: JSONValue
        do { root = try JSONDecoder().decode(JSONValue.self, from: data) }
        catch { throw LegacyAdapterError.invalidResponse }
        guard case .object(let response) = root,
              case .array(let items)? = response["trips"],
              response["error"] == nil || response["error"] == .null else {
            throw LegacyAdapterError.invalidResponse
        }

        var seen = Set<String>()
        return try items.map { value in
            guard let trip = value.object, let id = trip["tripId"]?.identifier else {
                throw LegacyAdapterError.invalidTrip
            }
            guard seen.insert(id).inserted else { throw LegacyAdapterError.duplicateIdentifier(id) }
            let revision: Int
            if let rawRevision = trip["revision"], rawRevision != .null {
                guard case .number(let number) = rawRevision, number.isFinite,
                      number >= 0, number.rounded() == number,
                      number <= 9_007_199_254_740_991 else { throw LegacyAdapterError.invalidTrip }
                revision = Int(number)
            } else { revision = 0 }
            let role = trip["myGrant"]?["role"]?.text.flatMap(TripRole.init(rawValue:)) ?? .viewer

            // A timezone is inherited only from an explicitly linked destination.
            var destinationZones: [String: String] = [:]
            for destination in try list(trip["destinations"], kind: .destination) {
                if let destinationID = destination["destinationId"]?.identifier,
                   let zone = destination["timezone"]?.text, !zone.isEmpty {
                    destinationZones[destinationID] = zone
                }
            }
            var records: [ItineraryRecord] = []
            for kind in RecordKind.allCases {
                var recordIDs = Set<String>()
                for raw in try list(trip[kind.legacyList], kind: kind) {
                    guard let fields = raw.object, let recordID = fields[kind.legacyID]?.identifier else {
                        throw LegacyAdapterError.invalidRecord(kind.title)
                    }
                    guard recordIDs.insert(recordID).inserted else {
                        throw LegacyAdapterError.duplicateIdentifier(recordID)
                    }
                    records.append(record(fields, raw: raw, id: recordID, tripID: id,
                                          kind: kind, destinationZones: destinationZones))
                }
            }
            return TripSnapshot(id: id, name: text(trip, "name", fallback: "Untitled trip"),
                                startDate: text(trip, "startDate"), endDate: text(trip, "endDate"),
                                notes: text(trip, "notes"), revision: revision, role: role,
                                records: records, raw: value)
        }
    }

    private static func list(_ value: JSONValue?, kind: RecordKind) throws -> [JSONValue] {
        guard let value, value != .null else { return [] }
        guard case .array(let items) = value else { throw LegacyAdapterError.invalidRecord(kind.title) }
        return items
    }

    private static func text(_ fields: [String: JSONValue], _ key: String, fallback: String = "") -> String {
        guard let result = fields[key]?.text, !result.isEmpty else { return fallback }
        return result
    }

    private static func record(_ fields: [String: JSONValue], raw: JSONValue, id: String,
                               tripID: String, kind: RecordKind,
                               destinationZones: [String: String]) -> ItineraryRecord {
        var title: String
        var start: String
        var end: String
        var allDay = false
        var zone: String?
        var place: Place
        switch kind {
        case .destination:
            title = text(fields, "name", fallback: "Destination")
            start = text(fields, "arriveDate"); end = text(fields, "departDate")
            allDay = true; zone = fields["timezone"]?.text
            place = Place(venue: title, address: text(fields, "country"),
                          latitude: fields["lat"]?.coordinate, longitude: fields["lng"]?.coordinate)
        case .transport:
            let service = [text(fields, "carrier"), text(fields, "flightNumber")].filter { !$0.isEmpty }.joined(separator: " ")
            let route = [text(fields, "fromLocation"), text(fields, "toLocation")].filter { !$0.isEmpty }.joined(separator: " → ")
            title = service.isEmpty ? (route.isEmpty ? text(fields, "mode", fallback: "Transport") : route) : service
            start = text(fields, "departDateTime"); end = text(fields, "arriveDateTime")
            allDay = !start.contains("T") && !end.contains("T")
            // The map shows departure; arrival coordinates remain in raw until route support.
            place = Place(venue: text(fields, "fromLocation"), address: text(fields, "fromLocation"),
                          latitude: fields["fromLat"]?.coordinate, longitude: fields["fromLng"]?.coordinate)
        case .accommodation:
            title = text(fields, "name", fallback: "Accommodation")
            start = text(fields, "checkIn"); end = text(fields, "checkOut")
            allDay = !start.contains("T") && !end.contains("T")
            place = Place(venue: title, address: text(fields, "address"),
                          latitude: fields["lat"]?.coordinate, longitude: fields["lng"]?.coordinate)
        case .activity:
            title = text(fields, "title", fallback: "Activity")
            let startDate = text(fields, "startDate", fallback: text(fields, "date"))
            let endDate = text(fields, "endDate", fallback: startDate)
            allDay = fields["allDay"]?.truthy ?? false
            start = dateTime(startDate, time: allDay ? "" : text(fields, "startTime"))
            end = dateTime(endDate, time: allDay ? "" : text(fields, "endTime"))
            // Venue is descriptive. Pin only the separately recorded address.
            place = Place(venue: text(fields, "location"), address: text(fields, "address"),
                          latitude: fields["addressLat"]?.coordinate, longitude: fields["addressLng"]?.coordinate)
        }
        if zone == nil, let destinationID = fields["destinationId"]?.identifier {
            zone = destinationZones[destinationID]
        }
        let companions: [String]
        if case .array(let values)? = fields["companions"] {
            companions = values.compactMap(\.identifier)
        } else { companions = [] }
        return ItineraryRecord(id: id, tripID: tripID, kind: kind, title: title,
                               start: start, end: end, allDay: allDay, timeZoneID: zone,
                               place: place, notes: text(fields, "notes"), companions: companions, raw: raw)
    }

    private static func dateTime(_ date: String, time: String) -> String {
        guard !date.isEmpty else { return "" }
        return time.isEmpty ? date : date + "T" + time
    }
}
