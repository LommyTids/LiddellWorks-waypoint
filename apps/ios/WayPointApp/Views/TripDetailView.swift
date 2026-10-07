import SwiftUI
import MapKit
import WayPointCore

struct TripDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let tripID: String
    @State private var selectedPage: TripPage = .itinerary
    @State private var showMap = false
    @State private var selectedPeople: Set<String> = []
    @State private var collapsedDays: Set<String> = []
    @State private var editor: EditorRequest?

    var body: some View {
        Group {
            if let trip = model.trip(id: tripID) {
                VStack(spacing: 0) {
                    if dynamicTypeSize.isAccessibilitySize {
                        ScrollView { tripControls(trip) }
                            .frame(maxHeight: 280)
                    } else {
                        tripControls(trip)
                    }
                    switch selectedPage {
                    case .itinerary:
                        if showMap {
                            TripMapView(records: visibleRecords(trip)) { open($0, in: trip) }
                        } else {
                            itinerary(trip, groupedByKind: false)
                        }
                    case .plan: itinerary(trip, groupedByKind: true)
                    case .people: people(trip)
                    case .more: more(trip)
                    }
                }
                .navigationTitle("Your trip")
                .navigationBarTitleDisplayMode(.inline)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    HStack(spacing: 0) {
                        ForEach(TripPage.allCases) { page in
                            Button { selectedPage = page } label: {
                                VStack(spacing: 5) {
                                    Image(systemName: page.symbol).font(.title3)
                                    Text(page.rawValue).font(.caption.weight(.semibold))
                                }
                                // Match native tab-bar scaling while the itinerary
                                // itself keeps the user's full accessibility size.
                                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                                .foregroundStyle(selectedPage == page ? WayPointStyle.teal : WayPointStyle.muted)
                                .frame(maxWidth: .infinity, minHeight: 56)
                                .background(selectedPage == page ? WayPointStyle.tealSoft : Color.clear,
                                            in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(page.rawValue)
                            .accessibilityAddTraits(selectedPage == page ? [.isSelected] : [])
                        }
                    }
                    .padding(8)
                    .background(WayPointStyle.surface)
                    .overlay(alignment: .top) { Rectangle().fill(WayPointStyle.line).frame(height: 1) }
                }
                .onChange(of: trip) { _, updated in
                    // A refresh may remove people; the filter never retains stale identities.
                    selectedPeople.formIntersection(Set(TripParticipant.all(in: updated).map(\.id)))
                }
            } else {
                ContentUnavailableView("Trip unavailable", systemImage: "suitcase", description: Text("It may have been removed or your access may have changed. Return to your trips and refresh."))
            }
        }
        .background(WayPointStyle.canvas)
        .toolbar(.hidden, for: .tabBar)
        .sheet(item: $editor) { request in
            NavigationStack {
                RecordEditorView(tripID: tripID, kind: request.kind, existing: request.existing,
                                 expectedRevision: request.revision, initialParticipants: request.participants)
            }
        }
    }

    private func tripControls(_ trip: TripSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    tripTitle(trip)
                    Spacer()
                    accessBadge(trip)
                }
                VStack(alignment: .leading, spacing: 6) {
                    tripTitle(trip)
                    accessBadge(trip)
                }
            }
            Text(LocalTripDate.range(start: trip.startDate, end: trip.endDate))
                .font(.subheadline).foregroundStyle(WayPointStyle.muted)
            if trip.role.allowsAddingAndDeleting && (selectedPage == .itinerary || selectedPage == .plan) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(RecordKind.allCases) { kind in
                            Button {
                                editor = EditorRequest(kind: kind, revision: trip.revision,
                                                       participants: TripParticipant.all(in: trip).map(\.id).filter { selectedPeople.contains($0) })
                            } label: { Label(kind.shortTitle, systemImage: "plus") }
                                .buttonStyle(AtlasButtonStyle(role: .amendment))
                                .disabled(model.isBusy)
                                .accessibilityIdentifier("add-" + kind.rawValue)
                        }
                    }
                }
                .accessibilityLabel("Add to trip")
            }
            if trip.role == .admin || trip.role == .superuser {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        filterButton("All people", selected: selectedPeople.isEmpty) { selectedPeople.removeAll() }
                        ForEach(TripParticipant.all(in: trip)) { person in
                            filterButton(person.name, selected: selectedPeople.contains(person.id)) {
                                if selectedPeople.contains(person.id) { selectedPeople.remove(person.id) }
                                else { selectedPeople.insert(person.id) }
                            }
                        }
                    }
                }
                .accessibilityLabel("View plans for travellers")
            }
            if selectedPage == .itinerary {
                HStack(spacing: 8) {
                    modeButton("Agenda", symbol: "list.bullet", selected: !showMap) { showMap = false }
                    modeButton("Map", symbol: "map", selected: showMap) { showMap = true }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(WayPointStyle.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(WayPointStyle.line).frame(height: 1) }
    }

    private func tripTitle(_ trip: TripSnapshot) -> some View {
        Text(trip.name).font(.system(.title2, design: .serif, weight: .semibold))
            .foregroundStyle(WayPointStyle.navy).fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private func accessBadge(_ trip: TripSnapshot) -> some View {
        Text(trip.role.displayTitle).font(.caption.weight(.semibold))
            .foregroundStyle(WayPointStyle.muted)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(WayPointStyle.subdued, in: Capsule())
    }

    private func filterButton(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if selected { Image(systemName: "checkmark") }
                Text(title)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12).frame(minHeight: 44)
            .foregroundStyle(selected ? WayPointStyle.teal : WayPointStyle.muted)
            .background(selected ? WayPointStyle.tealSoft : WayPointStyle.surface, in: Capsule())
            .overlay(Capsule().stroke(selected ? WayPointStyle.teal : WayPointStyle.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func modeButton(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).frame(maxWidth: .infinity)
        }
        .buttonStyle(AtlasButtonStyle(role: selected ? .selection : .neutral))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func visibleRecords(_ trip: TripSnapshot) -> [ItineraryRecord] {
        ItineraryPresentation.records(in: trip, selectedPeople: selectedPeople)
    }

    private func itinerary(_ trip: TripSnapshot, groupedByKind: Bool) -> some View {
        let records = visibleRecords(trip)
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    DraftNotice(isDemo: model.isDemo)
                    if records.isEmpty {
                        ContentUnavailableView("No plans to show", systemImage: "suitcase.rolling", description: Text(trip.role.allowsAddingAndDeleting ? "Add an area, journey, stay or activity above, or choose All people." : "There are no itinerary items to display yet."))
                    } else if groupedByKind {
                        ForEach(RecordKind.allCases) { kind in
                            let plans = sorted(records.filter { $0.kind == kind })
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Label(kind.pluralTitle, systemImage: kind.symbol).font(.headline)
                                    Spacer()
                                    Text("\(plans.count)").font(.subheadline).foregroundStyle(WayPointStyle.muted)
                                }
                                .foregroundStyle(WayPointStyle.navy)
                                if plans.isEmpty {
                                    Text("Nothing planned yet").font(.subheadline).foregroundStyle(WayPointStyle.muted)
                                } else {
                                    ForEach(plans, id: \.viewIdentity) { record in recordButton(record, trip: trip) }
                                }
                            }
                        }
                    } else {
                        agendaActions(records, proxy: proxy)
                        ForEach(dayKeys(records), id: \.self) { day in
                            let plans = sorted(records.filter { String($0.start.prefix(10)) == day })
                            VStack(alignment: .leading, spacing: 10) {
                                Button {
                                    if collapsedDays.contains(day) { collapsedDays.remove(day) }
                                    else { collapsedDays.insert(day) }
                                } label: {
                                    HStack(alignment: .top, spacing: 12) {
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(dayTitle(day)).font(.headline).foregroundStyle(WayPointStyle.navy)
                                            Text("\(plans.count) plan\(plans.count == 1 ? "" : "s")")
                                                .font(.caption).foregroundStyle(WayPointStyle.muted)
                                            if collapsedDays.contains(day) {
                                                ParticipantNames(trip: trip, ids: Array(Set(plans.flatMap(\.companions))).sorted())
                                            }
                                        }
                                        Spacer()
                                        Image(systemName: collapsedDays.contains(day) ? "chevron.down" : "chevron.up")
                                            .foregroundStyle(WayPointStyle.teal)
                                    }
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint(collapsedDays.contains(day) ? "Expand this day" : "Collapse this day")
                                if !collapsedDays.contains(day) {
                                    ForEach(plans, id: \.viewIdentity) { record in recordButton(record, trip: trip) }
                                }
                            }
                            .id(day)
                        }
                    }
                }
                .padding(20)
                .frame(maxWidth: 860)
                .frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("trip-itinerary")
        }
    }

    @ViewBuilder
    private func agendaActions(_ records: [ItineraryRecord], proxy: ScrollViewProxy) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
                collapseButton(records)
                dateJump(records, proxy: proxy)
            }
        } else {
            HStack {
                collapseButton(records)
                Spacer()
                dateJump(records, proxy: proxy)
            }
        }
    }

    private func collapseButton(_ records: [ItineraryRecord]) -> some View {
        Button(collapsedDays.isSuperset(of: Set(dayKeys(records))) ? "Expand all" : "Collapse all") {
            let days = Set(dayKeys(records))
            if collapsedDays.isSuperset(of: days) { collapsedDays.subtract(days) }
            else { collapsedDays.formUnion(days) }
        }
        .font(.subheadline.weight(.semibold))
        .frame(minHeight: 44)
    }

    private func dateJump(_ records: [ItineraryRecord], proxy: ScrollViewProxy) -> some View {
        Menu {
            ForEach(dayKeys(records), id: \.self) { day in
                Button(dayTitle(day)) {
                    collapsedDays.remove(day)
                    proxy.scrollTo(day, anchor: .top)
                }
            }
        } label: {
            Label("Jump to date", systemImage: "calendar").frame(minHeight: 44)
        }
        .font(.subheadline.weight(.semibold))
    }

    private func people(_ trip: TripSnapshot) -> some View {
        let ids = Set(trip.records.flatMap(\.companions))
        let participants = TripParticipant.all(in: trip).filter {
            trip.role == .superuser || trip.role == .admin || ids.contains($0.id)
        }
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Travellers").font(.system(.title2, design: .serif, weight: .semibold)).foregroundStyle(WayPointStyle.navy)
                Text("People joining this journey. Named assignments appear on each plan.")
                    .font(.subheadline).foregroundStyle(WayPointStyle.muted)
                ForEach(participants) { person in
                    HStack(spacing: 14) {
                        Image(systemName: "person.crop.circle").font(.title).foregroundStyle(WayPointStyle.teal)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(person.name).font(.headline).foregroundStyle(WayPointStyle.navy)
                            let count = trip.records.filter { $0.companions.contains(person.id) }.count
                            Text("\(count) assigned plan\(count == 1 ? "" : "s") in your view")
                                .font(.caption).foregroundStyle(WayPointStyle.muted)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(16).atlasCard()
                }
                Text("Manage travellers, contacts and account access in the WayPoint web app.")
                    .font(.footnote).foregroundStyle(WayPointStyle.muted)
            }
            .padding(20).frame(maxWidth: 860).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func more(_ trip: TripSnapshot) -> some View {
        Form {
            Group {
                Section("Trip") {
                    LabeledContent("Your access", value: trip.role.displayTitle)
                    if !trip.notes.isEmpty { Text(trip.notes) }
                }
                Section("Saved on this device") {
                    DraftNotice(isDemo: model.isDemo)
                    if !model.isDemo {
                        Button { Task { await model.refresh() } } label: { Label("Sync now", systemImage: "arrow.clockwise") }
                            .disabled(!model.canRefresh)
                    }
                }
                Section {
                    Text("Expenses and sharing are available in the WayPoint web app.")
                        .foregroundStyle(WayPointStyle.muted)
                }
            }
            .listRowBackground(WayPointStyle.surface)
        }
        .atlasForm()
    }

    private func open(_ record: ItineraryRecord, in trip: TripSnapshot) {
        guard !model.isBusy else { return }
        editor = EditorRequest(existing: record, revision: trip.revision)
    }

    private func recordButton(_ record: ItineraryRecord, trip: TripSnapshot) -> some View {
        Button { open(record, in: trip) } label: {
            ItineraryRow(trip: trip, record: record, isDraft: model.workspace?.mutations.contains { $0.tripID == tripID && $0.recordID == record.id && $0.kind == record.kind } ?? false)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Open itinerary details")
    }

    private func sorted(_ records: [ItineraryRecord]) -> [ItineraryRecord] {
        records.sorted {
            if $0.start == $1.start { return $0.viewIdentity < $1.viewIdentity }
            if $0.start.isEmpty { return false }
            if $1.start.isEmpty { return true }
            return $0.start < $1.start
        }
    }

    private func dayTitle(_ day: String) -> String { day.isEmpty ? "Date to be planned" : LocalTripDate.day(day) }

    private func dayKeys(_ records: [ItineraryRecord]) -> [String] {
        Set(records.map { String($0.start.prefix(10)) }).sorted { lhs, rhs in
            if lhs.isEmpty { return false }
            if rhs.isEmpty { return true }
            return lhs < rhs
        }
    }
}

private enum TripPage: String, CaseIterable, Identifiable {
    case itinerary = "Itinerary", plan = "Plan", people = "People", more = "More"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .itinerary: return "list.bullet.rectangle"
        case .plan: return "square.grid.2x2"
        case .people: return "person.2"
        case .more: return "ellipsis.circle"
        }
    }
}

private struct EditorRequest: Identifiable {
    let id = UUID()
    let kind: RecordKind
    let existing: ItineraryRecord?
    let revision: Int
    let participants: [String]
    init(kind: RecordKind, revision: Int, participants: [String]) {
        self.kind = kind; existing = nil; self.revision = revision; self.participants = participants
    }
    init(existing: ItineraryRecord, revision: Int) {
        kind = existing.kind; self.existing = existing; self.revision = revision; participants = []
    }
}

private extension RecordKind {
    var shortTitle: String {
        switch self {
        case .destination: return "Area"
        case .transport: return "Travel"
        case .accommodation: return "Stay"
        case .activity: return "Activity"
        }
    }
    var pluralTitle: String {
        switch self {
        case .destination: return "Areas"
        case .transport: return "Travel"
        case .accommodation: return "Stays"
        case .activity: return "Activities"
        }
    }
}

private struct ItineraryRow: View {
    let trip: TripSnapshot
    let record: ItineraryRecord
    let isDraft: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            RecordKindIcon(kind: record.kind)
            VStack(alignment: .leading, spacing: 7) {
                Text(record.title).font(.headline).foregroundStyle(WayPointStyle.navy)
                if record.allDay {
                    Text("All day").font(.caption).foregroundStyle(.secondary)
                } else if let start = LocalTripDate.time(record.start) {
                    Text(timeLabel(start)).font(.caption.weight(.medium)).foregroundStyle(WayPointStyle.teal)
                }
                if !record.place.venue.isEmpty {
                    Text(record.place.venue).font(.subheadline).foregroundStyle(.primary)
                }
                if !record.place.address.isEmpty {
                    Label(record.place.address, systemImage: "mappin")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if !record.notes.isEmpty {
                    Text(record.notes).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if record.kind == .transport {
                    let arrival = TripParticipant.text(record.raw["toLocation"])
                    if !arrival.isEmpty {
                        Label("To \(arrival)", systemImage: "arrow.right").font(.caption).foregroundStyle(WayPointStyle.muted)
                    }
                    let flight = TripParticipant.text(record.raw["flightNumber"])
                    if !flight.isEmpty { Text(flight).font(.caption.weight(.semibold)).foregroundStyle(WayPointStyle.muted) }
                }
                if let zone = record.timeZoneID, !zone.isEmpty {
                    Text(zone.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(WayPointStyle.muted)
                }
                ParticipantNames(trip: trip, ids: record.companions)
                if isDraft { LocalDraftBadge() }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        .padding(16)
        .atlasCard()
        .accessibilityElement(children: .combine)
    }

    private func timeLabel(_ start: String) -> String {
        guard let end = LocalTripDate.time(record.end) else { return start }
        if record.start.prefix(10) == record.end.prefix(10) { return "\(start) – \(end)" }
        return "\(start) – \(LocalTripDate.day(record.end)), \(end)"
    }
}

private struct TripMapView: View {
    let records: [ItineraryRecord]
    let openRecord: (ItineraryRecord) -> Void
    @State private var position: MapCameraPosition = .automatic

    private var pinnedRecords: [ItineraryRecord] { records.filter { $0.place.hasCoordinate } }

    var body: some View {
        VStack(spacing: 0) {
            if pinnedRecords.isEmpty {
                ContentUnavailableView("No saved map pins", systemImage: "mappin.slash", description: Text("Choose an address in an itinerary item to save a place on the map."))
                    .frame(maxHeight: .infinity)
            } else {
                Map(position: $position) {
                    ForEach(pinnedRecords, id: \.viewIdentity) { record in
                        if let latitude = record.place.latitude, let longitude = record.place.longitude {
                            Annotation(record.title, coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude)) {
                                Button { openRecord(record) } label: {
                                    Image(systemName: record.kind.symbol)
                                        .font(.headline)
                                        .foregroundStyle(.white)
                                        .frame(width: 44, height: 44)
                                        .background(WayPointStyle.color(for: record.kind), in: Circle())
                                        .overlay(Circle().stroke(.white, lineWidth: 2))
                                        .shadow(radius: 3, y: 2)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(record.title), \(record.kind.title)")
                                .accessibilityHint("Open itinerary details")
                            }
                        }
                    }
                }
                .mapControls { MapCompass(); MapScaleView() }
                .overlay(alignment: .topTrailing) {
                    Button { position = .automatic } label: {
                        Label("Show all pins", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.caption.weight(.semibold))
                            .padding(12)
                            .background(.regularMaterial, in: Capsule())
                    }
                    .padding(12)
                }
            }
            Label("Map imagery needs a connection. Saved trip details remain available offline.", systemImage: "info.circle")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(.regularMaterial)
        }
    }
}

private extension ItineraryRecord {
    var viewIdentity: String { kind.rawValue + ":" + id }
}
