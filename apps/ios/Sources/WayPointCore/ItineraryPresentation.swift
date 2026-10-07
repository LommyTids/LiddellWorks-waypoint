import Foundation

/// A viewing lens over the already authorized snapshot, never an access grant.
public enum ItineraryPresentation {
    public static func records(in trip: TripSnapshot, selectedPeople: Set<String>) -> [ItineraryRecord] {
        guard trip.role == .superuser || trip.role == .admin, !selectedPeople.isEmpty else {
            return trip.records
        }
        return trip.records.filter { record in
            record.companions.isEmpty || !selectedPeople.isDisjoint(with: record.companions)
        }
    }
}
