import SwiftUI
import UIKit
import MapKit
import WayPointCore

@MainActor
struct TripDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let tripID: String
    @State private var selectedPage: TripPage = .itinerary
    @State private var showMap = false
    @State private var selectedPeople: Set<String> = []
    @State private var collapsedDays: Set<String> = []
    @State private var editor: EditorRequest?
    @State private var detail: RecordDetailRequest?
    @State private var showPeopleFilter = false
    @State private var controlsHeight: CGFloat = 64
    @State private var dayAnchors = DayAnchorRegistry()

    var body: some View {
        Group {
            if let trip = model.trip(id: tripID) {
                tripContent(trip)
                    .overlay(alignment: .bottom) { bottomNavigation }
                    .onChange(of: trip) { _, updated in
                        selectedPeople.formIntersection(Set(TripParticipant.all(in: updated).map(\.id)))
                    }
            } else {
                ContentUnavailableView("Trip unavailable", systemImage: "suitcase", description: Text("It may have been removed or your access may have changed. Return to your trips and refresh."))
            }
        }
        .background(WayPointStyle.canvas)
        .navigationTitle("WayPoint")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                WayPointBrand(compact: true).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            }
            ToolbarItem(placement: .topBarTrailing) {
                if model.isBusy {
                    ProgressView().accessibilityLabel("Syncing trip")
                } else {
                    Button { selectedPage = .more } label: {
                        Image(systemName: model.isDemo ? "internaldrive" : "checkmark.icloud")
                    }
                    .accessibilityLabel(model.isDemo ? "Demo storage and pending changes" : "Sync status and pending changes")
                }
            }
        }
        .sheet(item: $editor) { request in
            NavigationStack {
                RecordEditorView(tripID: tripID, kind: request.kind, expectedRevision: request.revision,
                                 initialParticipants: request.participants)
            }
        }
        .sheet(item: $detail) { request in
            NavigationStack { RecordDetailView(tripID: tripID, recordID: request.recordID, kind: request.kind) }
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showPeopleFilter) {
            if let trip = model.trip(id: tripID) {
                NavigationStack { TravellerFilterView(trip: trip, selection: $selectedPeople) }
                    .presentationDetents([.medium, .large])
            }
        }
    }

    @ViewBuilder private func tripContent(_ trip: TripSnapshot) -> some View {
        switch selectedPage {
        case .itinerary:
            if showMap {
                VStack(spacing: 0) {
                    tripControls(trip).padding(.horizontal, 14)
                    TripMapView(records: visibleRecords(trip)) { open($0) }
                        .safeAreaInset(edge: .bottom) { Color.clear.frame(height: 76) }
                }
            } else { itinerary(trip, groupedByKind: false) }
        case .plan: itinerary(trip, groupedByKind: true)
        case .people: people(trip)
        case .more: more(trip)
        }
    }

    private var bottomNavigation: some View {
        HStack(spacing: 2) {
            ForEach(TripPage.allCases) { page in
                Button { selectedPage = page } label: {
                    VStack(spacing: 2) {
                        if page == .itinerary {
                            WayPointMark(width: 27).frame(height: 24)
                        } else {
                            Image(systemName: page.symbol).font(.system(size: 18))
                                .frame(height: 24)
                        }
                        Text(page.rawValue).font(.caption2.weight(.medium))
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                    // Native navigation scale limits; content retains full Dynamic Type.
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .foregroundStyle(selectedPage == page ? WayPointStyle.teal : WayPointStyle.muted)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(selectedPage == page ? WayPointStyle.tealSoft : Color.clear, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(page.rawValue)
                .accessibilityAddTraits(selectedPage == page ? [.isSelected] : [])
                .accessibilityIdentifier("trip-tab-" + page.rawValue.lowercased())
            }
        }
        .padding(4).atlasGlass(cornerRadius: 34)
        .frame(maxWidth: 500).padding(.horizontal, 14).padding(.bottom, 8)
    }

    private func tripIdentity(_ trip: TripSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(trip.name).font(WayPointType.display).foregroundStyle(WayPointStyle.navy)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("trip-title")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { tripDates(trip); identityBadges(trip) }
                VStack(alignment: .leading, spacing: 6) { tripDates(trip); identityBadges(trip) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 5).padding(.top, 12).padding(.bottom, 4)
    }

    private func tripDates(_ trip: TripSnapshot) -> some View {
        Text(LocalTripDate.range(start: trip.startDate, end: trip.endDate))
            .font(WayPointType.meta).foregroundStyle(WayPointStyle.muted)
            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("trip-dates")
    }

    private func identityBadges(_ trip: TripSnapshot) -> some View {
        HStack(spacing: 6) {
            Text(trip.role.displayTitle).foregroundStyle(WayPointStyle.muted)
            if model.isDemo {
                Text("Demo").foregroundStyle(WayPointStyle.teal)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(WayPointStyle.tealSoft, in: RoundedRectangle(cornerRadius: 5))
            }
        }
        .font(WayPointType.micro).fixedSize(horizontal: true, vertical: false)
    }

    private func tripControls(_ trip: TripSnapshot) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    if trip.role.allowsAddingAndDeleting { peopleFilterButton; addMenu(trip) }
                    if selectedPage == .itinerary { modeSelection }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 4) {
                        if trip.role.allowsAddingAndDeleting { peopleFilterButton }
                        Spacer(minLength: 0)
                        if selectedPage == .itinerary { modeSelection }
                        if trip.role.allowsAddingAndDeleting { addMenu(trip) }
                    }
                    VStack(spacing: 4) {
                        HStack {
                            if trip.role.allowsAddingAndDeleting { peopleFilterButton; Spacer(); addMenu(trip) }
                        }
                        if selectedPage == .itinerary { modeSelection }
                    }
                }
            }
        }
        .padding(6).atlasGlass().padding(.vertical, 4)
    }

    private var peopleFilterButton: some View {
        Button { showPeopleFilter = true } label: {
            HStack(spacing: 5) {
                Image(systemName: "person.2").font(.caption)
                Text(selectedPeople.isEmpty ? "Everyone" : "\(selectedPeople.count) selected")
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
            }
            .font(.caption.weight(.medium)).fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(WayPointStyle.teal)
            .padding(.horizontal, 7).frame(minHeight: 44).contentShape(Capsule())
        }
        .buttonStyle(.plain).accessibilityLabel("People in view")
        .accessibilityValue(selectedPeople.isEmpty ? "Everyone" : "\(selectedPeople.count) selected")
        .accessibilityIdentifier("trip-people-filter")
    }

    private func addMenu(_ trip: TripSnapshot) -> some View {
        Menu {
            ForEach(RecordKind.allCases) { kind in
                Button {
                    editor = EditorRequest(kind: kind, revision: trip.revision,
                                           participants: TripParticipant.all(in: trip).map(\.id).filter { selectedPeople.contains($0) })
                } label: { Label(kind.shortTitle, systemImage: kind.symbol) }
                .accessibilityIdentifier("add-" + kind.rawValue)
            }
        } label: {
            Label("Add", systemImage: "plus").font(.caption.weight(.semibold))
                .fixedSize(horizontal: true, vertical: false).foregroundStyle(WayPointStyle.amber)
                .padding(.horizontal, 12).frame(minHeight: 44)
                .background(WayPointStyle.amberSoft, in: Capsule())
        }
        .disabled(model.isBusy).accessibilityLabel("Add to trip").accessibilityIdentifier("trip-add")
    }

    private var modeSelection: some View {
        HStack(spacing: 0) {
            modeButton("Agenda", selected: !showMap) { showMap = false }
            modeButton("Map", selected: showMap) { showMap = true }
        }
        .accessibilityElement(children: .contain).accessibilityLabel("Itinerary view")
    }

    private func modeButton(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.caption.weight(.medium)).fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 10).frame(minHeight: 44)
                .foregroundStyle(selected ? WayPointStyle.teal : WayPointStyle.muted)
                .background(selected ? WayPointStyle.tealSoft : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain).accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func visibleRecords(_ trip: TripSnapshot) -> [ItineraryRecord] {
        ItineraryPresentation.records(in: trip, selectedPeople: selectedPeople)
    }

    private func itinerary(_ trip: TripSnapshot, groupedByKind: Bool) -> some View {
        let records = visibleRecords(trip)
        return GeometryReader { viewport in
            ScrollView {
                // Keep enough room to scroll the identity away even on a short trip.
                // Only the section header pins; the body can still clear the dock.
                LazyVStack(alignment: .leading, spacing: 14, pinnedViews: [.sectionHeaders]) {
                    tripIdentity(trip)
                    Section {
                        VStack(alignment: .leading, spacing: 14) {
                            if records.isEmpty {
                                ContentUnavailableView("No plans to show", systemImage: "suitcase.rolling", description: Text(trip.role.allowsAddingAndDeleting ? "Add a plan or choose Everyone." : "There are no itinerary items to display yet."))
                            } else if groupedByKind {
                                ForEach(RecordKind.allCases) { kind in kindGroup(kind, records: records, trip: trip) }
                            } else {
                                ForEach(dayKeys(records), id: \.self) { day in dayGroup(day, records: records, trip: trip) }
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: max(0, viewport.size.height - controlsHeight - 80), alignment: .topLeading)
                    } header: {
                        tripControls(trip)
                            .background {
                                ItineraryScrollAnchor(kind: .controls, registry: dayAnchors) { height in
                                    if height > 0 && abs(height - controlsHeight) > 0.5 {
                                        DispatchQueue.main.async { controlsHeight = height }
                                    }
                                }
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .allowsHitTesting(false).accessibilityHidden(true)
                            }
                    }
                }
                .padding(.horizontal, 14).padding(.bottom, 16)
                .frame(maxWidth: 860).frame(maxWidth: .infinity)
            }
            .contentMargins(.bottom, 80, for: .scrollContent)
            .accessibilityIdentifier("trip-itinerary")
        }
        .background(alignment: .top) {
            ItineraryScrollAnchor(kind: .viewport, registry: dayAnchors).frame(height: 1)
                .allowsHitTesting(false).accessibilityHidden(true)
        }
    }

    private func kindGroup(_ kind: RecordKind, records: [ItineraryRecord], trip: TripSnapshot) -> some View {
        let plans = sorted(records.filter { $0.kind == kind })
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(kind.pluralTitle).font(WayPointType.heading)
                Spacer()
                Text("\(plans.count)").font(WayPointType.micro).foregroundStyle(WayPointStyle.muted)
            }
            .foregroundStyle(WayPointStyle.navy).padding(.horizontal, 4)
            if plans.isEmpty {
                Text("Nothing planned yet").font(WayPointType.body).foregroundStyle(WayPointStyle.muted)
            } else {
                ForEach(plans, id: \.viewIdentity) { record in recordButton(record, trip: trip) }
            }
        }
    }

    private func dayGroup(_ day: String, records: [ItineraryRecord], trip: TripSnapshot) -> some View {
        let plans = sorted(records.filter { String($0.start.prefix(10)) == day })
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Button {
                    if collapsedDays.contains(day) { collapsedDays.remove(day) }
                    else { collapsedDays.insert(day) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(dayTitle(day)).font(WayPointType.heading)
                            Image(systemName: collapsedDays.contains(day) ? "chevron.down" : "chevron.up")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(WayPointStyle.navy)
                        Text("\(plans.count) plan\(plans.count == 1 ? "" : "s")")
                            .font(WayPointType.micro).foregroundStyle(WayPointStyle.muted)
                        if collapsedDays.contains(day) {
                            ParticipantNames(trip: trip, ids: Array(Set(plans.flatMap(\.companions))).sorted())
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(collapsedDays.contains(day) ? "Expand this day" : "Collapse this day")
                agendaOptions(records)
                    .accessibilityIdentifier(day == dayKeys(records).first ? "agenda-options" : "agenda-options-" + day)
            }
            .padding(.horizontal, 4)
            if !collapsedDays.contains(day) {
                ForEach(plans, id: \.viewIdentity) { record in recordButton(record, trip: trip) }
            }
        }
        .background(alignment: .top) {
            ItineraryScrollAnchor(kind: .day(day), registry: dayAnchors).frame(height: 1)
                .allowsHitTesting(false).accessibilityHidden(true)
        }
    }

    private func agendaOptions(_ records: [ItineraryRecord]) -> some View {
        Menu {
            Button(collapsedDays.isSuperset(of: Set(dayKeys(records))) ? "Expand all" : "Collapse all") {
                let days = Set(dayKeys(records))
                if collapsedDays.isSuperset(of: days) { collapsedDays.subtract(days) }
                else { collapsedDays.formUnion(days) }
            }
            Section("Jump to date") {
                ForEach(dayKeys(records), id: \.self) { day in
                    Button(dayTitle(day)) {
                        collapsedDays.remove(day)
                        // Wait for expanded content to lay out, then align its
                        // actual position below the pinned controls.
                        DispatchQueue.main.async { dayAnchors.scroll(to: day) }
                    }
                    .accessibilityIdentifier("agenda-jump-" + day)
                }
            }
        } label: {
            Image(systemName: "calendar").font(.system(size: 16)).foregroundStyle(WayPointStyle.muted)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel("Agenda options")
    }

    private func people(_ trip: TripSnapshot) -> some View {
        let ids = Set(trip.records.flatMap(\.companions))
        let participants = TripParticipant.all(in: trip).filter {
            trip.role == .superuser || trip.role == .admin || ids.contains($0.id)
        }
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                tripIdentity(trip)
                Text("Travellers").font(WayPointType.heading).foregroundStyle(WayPointStyle.navy)
                ForEach(participants) { person in
                    HStack(spacing: 14) {
                        Image(systemName: "person.crop.circle").font(.title2).foregroundStyle(WayPointStyle.teal)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(person.name).font(WayPointType.label).foregroundStyle(WayPointStyle.navy)
                            let count = trip.records.filter { $0.companions.contains(person.id) }.count
                            Text("\(count) assigned plan\(count == 1 ? "" : "s") in your view")
                                .font(WayPointType.micro).foregroundStyle(WayPointStyle.muted)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(14).atlasCard(cornerRadius: 12)
                }
                Text("Manage travellers, contacts and account access in the WayPoint web app.")
                    .font(.footnote).foregroundStyle(WayPointStyle.muted)
            }
            .padding(16).frame(maxWidth: 860).frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.bottom, 80, for: .scrollContent)
    }

    private func more(_ trip: TripSnapshot) -> some View {
        Form {
            Group {
                Section("Trip") {
                    LabeledContent("Your access", value: trip.role.displayTitle)
                    Text(trip.name).font(WayPointType.heading)
                    Text(LocalTripDate.range(start: trip.startDate, end: trip.endDate)).font(WayPointType.meta)
                    if !trip.notes.isEmpty { Text(trip.notes) }
                }
                Section("Saved on this device") {
                    DraftNotice(isDemo: model.isDemo)
                    LabeledContent("Pending changes", value: "\(model.workspace?.mutations.filter { $0.tripID == tripID }.count ?? 0)")
                    if !model.isDemo {
                        Button { Task { await model.refresh() } } label: { Label("Sync now", systemImage: "arrow.clockwise") }
                            .disabled(!model.canRefresh || model.isBusy)
                    }
                }
                Section {
                    Text("Expenses and sharing are available in the WayPoint web app.").foregroundStyle(WayPointStyle.muted)
                }
            }
            .listRowBackground(WayPointStyle.surface)
        }
        .atlasForm().contentMargins(.bottom, 80, for: .scrollContent)
    }

    private func open(_ record: ItineraryRecord) {
        detail = RecordDetailRequest(recordID: record.id, kind: record.kind)
    }

    private func recordButton(_ record: ItineraryRecord, trip: TripSnapshot) -> some View {
        Button { open(record) } label: {
            ItineraryRow(trip: trip, record: record, isDraft: model.workspace?.mutations.contains { $0.tripID == tripID && $0.recordID == record.id && $0.kind == record.kind } ?? false)
        }
        .buttonStyle(.plain).accessibilityHint("Open itinerary details")
        .accessibilityIdentifier("record-" + record.viewIdentity)
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

private struct TravellerFilterView: View {
    @Environment(\.dismiss) private var dismiss
    let trip: TripSnapshot
    @Binding var selection: Set<String>
    var body: some View {
        Form {
            Section {
                Button { selection.removeAll() } label: {
                    HStack { Text("Everyone"); Spacer(); if selection.isEmpty { Image(systemName: "checkmark") } }
                }
                ForEach(TripParticipant.all(in: trip)) { person in
                    Button {
                        if selection.contains(person.id) { selection.remove(person.id) }
                        else { selection.insert(person.id) }
                    } label: {
                        HStack {
                            Text(person.name).foregroundStyle(WayPointStyle.navy)
                            Spacer()
                            Image(systemName: selection.contains(person.id) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(WayPointStyle.teal)
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .accessibilityValue(selection.contains(person.id) ? "Selected" : "Not selected")
                    .accessibilityAddTraits(selection.contains(person.id) ? [.isSelected] : [])
                    .accessibilityIdentifier("filter-person-" + person.id)
                }
            } footer: {
                Text("Plans for any selected person are included once. Unassigned plans remain visible.")
            }
            .listRowBackground(WayPointStyle.surface)
        }
        .atlasForm().navigationTitle("People in view").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
}

private enum TripPage: String, CaseIterable, Identifiable {
    case itinerary = "Itinerary", plan = "Plan", people = "People", more = "More"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .itinerary: return "list.bullet.rectangle"
        case .plan: return "square.stack.3d.up"
        case .people: return "person.2"
        case .more: return "ellipsis"
        }
    }
}
private struct EditorRequest: Identifiable {
    let id = UUID()
    let kind: RecordKind
    let revision: Int
    let participants: [String]
}
private struct RecordDetailRequest: Identifiable {
    let recordID: String
    let kind: RecordKind
    var id: String { kind.rawValue + ":" + recordID }
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let trip: TripSnapshot
    let record: ItineraryRecord
    let isDraft: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 8) {
                Text(timeSummary).font(WayPointType.meta).foregroundStyle(WayPointStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 2)
                Label(record.kind.shortTitle, systemImage: record.kind.symbol)
                    .font(WayPointType.micro).foregroundStyle(WayPointStyle.color(for: record.kind))
                    .fixedSize(horizontal: true, vertical: false)
            }
            Text(record.title).font(WayPointType.label).foregroundStyle(WayPointStyle.navy)
                .fixedSize(horizontal: false, vertical: true)
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 5) { context; assignments }
            } else {
                HStack(alignment: .top, spacing: 12) { context; Spacer(minLength: 0); assignments }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .atlasCard(cornerRadius: 12).accessibilityElement(children: .combine)
    }
    @ViewBuilder private var context: some View {
        if !contextText.isEmpty {
            Text(contextText).font(WayPointType.micro).foregroundStyle(WayPointStyle.muted)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        }
    }
    private var assignments: some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "person.2").accessibilityHidden(true)
            Text(record.companions.isEmpty ? "Unassigned" : record.companions.map { TripParticipant.name(for: $0, in: trip) }.joined(separator: ", "))
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            if isDraft {
                Image(systemName: "pencil.circle.fill").foregroundStyle(WayPointStyle.amber)
                    .accessibilityLabel("Pending change")
            }
        }
        .font(WayPointType.micro).foregroundStyle(WayPointStyle.muted)
    }
    private var contextText: String {
        if record.kind == .transport {
            let arrival = TripParticipant.text(record.raw["toLocation"])
            let flight = TripParticipant.text(record.raw["flightNumber"])
            let route = arrival.isEmpty ? record.place.venue : "→ " + arrival
            return [flight, route].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        return record.place.venue == record.title ? "" : record.place.venue
    }
    private var timeSummary: String {
        if record.allDay { return "All day" }
        guard let start = LocalTripDate.time(record.start) else { return "Time to be planned" }
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
        }
    }
}

private extension ItineraryRecord {
    var viewIdentity: String { kind.rawValue + ":" + id }
}

/// SwiftUI's fractional scroll alignment uses a target's full height. UIKit's
/// public coordinate conversion keeps a day heading clear of a pinned header,
/// even when that day's accessibility content is taller than the viewport.
@MainActor
private final class DayAnchorRegistry {
    private final class WeakAnchor {
        weak var view: UIView?
        init(_ view: UIView) { self.view = view }
    }
    private var anchors: [String: WeakAnchor] = [:]
    private var viewport: WeakAnchor?
    private var controls: WeakAnchor?

    func register(_ view: UIView, kind: ItineraryAnchorKind) {
        switch kind {
        case .day(let day): anchors[day] = WeakAnchor(view)
        case .viewport: viewport = WeakAnchor(view)
        case .controls: controls = WeakAnchor(view)
        }
    }

    func scroll(to day: String) {
        guard let anchor = anchors[day]?.view, let viewport = viewport?.view,
              let controls = controls?.view, let window = anchor.window else { return }
        anchor.window?.layoutIfNeeded()
        var ancestor = anchor.superview
        while let view = ancestor {
            if let scroll = view as? UIScrollView {
                let top = anchor.convert(.zero, to: window).y
                let windowTop = viewport.convert(.zero, to: window).y + controls.bounds.height + 14
                let minimum = -scroll.adjustedContentInset.top
                let maximum = max(minimum, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                let target = min(maximum, max(minimum, scroll.contentOffset.y + top - windowTop))
                scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: target), animated: false)
                return
            }
            ancestor = view.superview
        }
    }
}

private enum ItineraryAnchorKind { case viewport, controls, day(String) }

private final class ItineraryAnchorView: UIView {
    var onHeight: ((CGFloat) -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        onHeight?(bounds.height)
    }
}

private struct ItineraryScrollAnchor: UIViewRepresentable {
    let kind: ItineraryAnchorKind
    let registry: DayAnchorRegistry
    var onHeight: ((CGFloat) -> Void)? = nil
    func makeUIView(context: Context) -> ItineraryAnchorView {
        let view = ItineraryAnchorView()
        view.isUserInteractionEnabled = false
        view.onHeight = onHeight
        registry.register(view, kind: kind)
        return view
    }
    func updateUIView(_ uiView: ItineraryAnchorView, context: Context) {
        uiView.onHeight = onHeight
        registry.register(uiView, kind: kind)
    }
}
