import Foundation
import MapKit
import WayPointCore

/// Search needs a network connection, but no location permission. Coordinates
/// and the selected address are retained in the offline itinerary afterwards.
@MainActor
final class ApplePlaceSearch {
    private var activeSearch: MKLocalSearch?

    func search(_ query: String) async throws -> [Place] {
        activeSearch?.cancel()
        activeSearch = nil
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 3 else { return [] }
        try Task.checkCancellation()
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        request.resultTypes = [.address, .pointOfInterest]
        let search = MKLocalSearch(request: request)
        activeSearch = search
        defer {
            if activeSearch === search { activeSearch = nil }
        }
        return try await withTaskCancellationHandler {
            let response: MKLocalSearch.Response
            do {
                response = try await search.start()
            } catch {
                if Task.isCancelled || activeSearch !== search { throw CancellationError() }
                throw error
            }
            try Task.checkCancellation()
            guard activeSearch === search else { throw CancellationError() }
            return response.mapItems.compactMap { item in
                let coordinate = item.placemark.coordinate
                guard CLLocationCoordinate2DIsValid(coordinate) else { return nil }
                let placemark = item.placemark
                let street = [placemark.subThoroughfare, placemark.thoroughfare]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
                let address = [street, placemark.locality, placemark.administrativeArea,
                               placemark.postalCode, placemark.country]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
                return Place(
                    venue: item.name ?? "",
                    address: address.isEmpty ? (placemark.title ?? "") : address,
                    latitude: coordinate.latitude, longitude: coordinate.longitude
                )
            }
        } onCancel: {
            // Cancellation handlers can run on any executor. MapKit ownership
            // stays on the main actor, and this cancels only this search instance.
            Task { @MainActor in search.cancel() }
        }
    }
}
