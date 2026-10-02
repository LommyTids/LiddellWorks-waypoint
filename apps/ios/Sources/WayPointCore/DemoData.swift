import Foundation

public enum DemoData {
    /// Fixed, fictional records. This account never authenticates or syncs.
    public static var workspace: LocalWorkspace {
        let tripID = "demo-lisbon"
        let records: [ItineraryRecord] = [
            ItineraryRecord(id: "demo-destination", tripID: tripID, kind: .destination,
                            title: "Lisbon", start: "2026-10-03", end: "2026-10-07", allDay: true,
                            timeZoneID: "Europe/Lisbon",
                            place: Place(venue: "Lisbon", address: "Lisbon, Portugal", latitude: 38.7223, longitude: -9.1393),
                            notes: "A few days of exploring, food and sea air."),
            ItineraryRecord(id: "demo-stay", tripID: tripID, kind: .accommodation,
                            title: "Alfama guesthouse", start: "2026-10-03T15:00", end: "2026-10-07T11:00",
                            timeZoneID: "Europe/Lisbon",
                            place: Place(venue: "Alfama guesthouse", address: "Alfama, Lisbon", latitude: 38.7111, longitude: -9.1295),
                            notes: "Fictional booking. Check-in after 15:00."),
            ItineraryRecord(id: "demo-activity", tripID: tripID, kind: .activity,
                            title: "Sunset by the water", start: "2026-10-03T18:00", end: "2026-10-03T19:00",
                            timeZoneID: "Europe/Lisbon",
                            place: Place(venue: "Praça do Comércio", address: "Praça do Comércio, Lisbon", latitude: 38.7078, longitude: -9.1365),
                            notes: "An unhurried first evening."),
            ItineraryRecord(id: "demo-transport", tripID: tripID, kind: .transport,
                            title: "Train to Sintra", start: "2026-10-04T09:00", end: "2026-10-04T09:45",
                            timeZoneID: "Europe/Lisbon",
                            place: Place(venue: "Rossio station", address: "Rossio station, Lisbon", latitude: 38.7141, longitude: -9.1400),
                            notes: "Illustrative times only; this is not a timetable.",
                            raw: .object(["fromLocation": .string("Rossio station"), "toLocation": .string("Sintra")]))
        ]
        let trip = TripSnapshot(id: tripID, name: "A long weekend in Lisbon", startDate: "2026-10-03",
                                endDate: "2026-10-07", notes: "Sample trip • all changes stay on this device.",
                                revision: 0, role: .superuser, records: records,
                                raw: .object(["tripId": .string(tripID), "myGrant": .object(["role": .string("superuser")])]))
        return LocalWorkspace(account: Account(id: "demo", username: "Demo traveller"), trips: [trip])
    }
}
