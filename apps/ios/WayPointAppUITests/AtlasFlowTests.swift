import XCTest

final class AtlasFlowTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testLoginAndHelpKeepExistingCodeFlow() {
        let app = XCUIApplication()
        app.launch()
        let login = app.buttons["Log in to WayPoint"]
        XCTAssertTrue(login.waitForExistence(timeout: 10))
        capture("Welcome", app: app)
        login.tap()
        let code = app.textFields["login-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["login-submit"].isEnabled)
        capture("Login", app: app)
        code.tap()
        code.typeText("123")
        XCTAssertTrue(app.buttons["login-submit"].isEnabled)
        app.buttons["Done"].tap()
        app.buttons["Need help logging in?"].tap()
        XCTAssertTrue(app.navigationBars["Login help"].waitForExistence(timeout: 5))
        capture("Login help", app: app)
        app.navigationBars["Login help"].buttons["Done"].tap()
        XCTAssertEqual(code.value as? String, "123")
        // No credentials are submitted and no real account is used.
    }

    @MainActor
    func testDemoNavigationCollapseAndParticipantEditor() {
        let app = XCUIApplication()
        app.launch()
        app.buttons["Explore a demo trip"].tap()
        let trip = app.buttons["trip-demo-lisbon"]
        XCTAssertTrue(trip.waitForExistence(timeout: 10))
        capture("Trips", app: app)
        trip.tap()
        XCTAssertTrue(app.buttons["agenda-options"].waitForExistence(timeout: 5))
        capture("Agenda", app: app)
        app.buttons["agenda-options"].tap()
        app.buttons["Collapse all"].tap()
        app.buttons["agenda-options"].tap()
        XCTAssertTrue(app.buttons["Expand all"].exists)
        app.buttons["Expand all"].tap()
        app.buttons["Map"].tap()
        capture("Map", app: app)
        app.buttons["Plan"].tap()
        XCTAssertTrue(app.staticTexts["Areas"].exists)
        app.buttons["People"].tap()
        XCTAssertTrue(app.staticTexts["Travellers"].exists)
        app.buttons["More"].tap()
        XCTAssertTrue(app.staticTexts["Your access"].exists)
        app.buttons["Itinerary"].tap()
        app.buttons["Agenda"].tap()
        app.buttons["trip-people-filter"].tap()
        app.buttons["filter-person-__trip_superuser__"].tap()
        XCTAssertEqual(app.buttons["filter-person-__trip_superuser__"].value as? String, "Selected")
        capture("People selected", app: app)
        app.navigationBars["People in view"].buttons["Done"].tap()
        XCTAssertEqual(app.buttons["trip-people-filter"].value as? String, "1 selected")
        app.buttons["trip-add"].tap()
        app.buttons["add-activity"].tap()
        XCTAssertTrue(app.navigationBars["New activity"].waitForExistence(timeout: 5))
        app.swipeUp()
        XCTAssertTrue(app.switches["Trip owner"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.switches["Trip owner"].value as? String, "1")
        capture("Participant editor", app: app)
        app.buttons["Close"].tap()
    }

    @MainActor
    func testAccessibilityTextKeepsLoginAndAgendaReachable() {
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let login = app.buttons["Log in to WayPoint"]
        XCTAssertTrue(login.waitForExistence(timeout: 10))
        XCTAssertTrue(login.isHittable)
        capture("Welcome large text", app: app)
        login.tap()
        let code = app.textFields["login-code"]
        for _ in 0..<4 where !code.isHittable { app.swipeUp() }
        XCTAssertTrue(code.isHittable)
        capture("Login large text", app: app)
        app.navigationBars["Log in"].buttons.firstMatch.tap()
        app.buttons["Explore a demo trip"].tap()
        let trip = app.buttons["trip-demo-lisbon"]
        XCTAssertTrue(trip.waitForExistence(timeout: 10))
        for _ in 0..<4 where !trip.isHittable { app.swipeUp() }
        XCTAssertTrue(trip.isHittable)
        trip.tap()
        let options = app.buttons["agenda-options"]
        capture("Agenda large text initial", app: app)
        let dock = app.buttons["trip-tab-more"]
        revealAgendaOptions(options, app: app)
        XCTAssertTrue(options.isHittable)
        XCTAssertLessThan(options.frame.maxY, dock.frame.minY)
        capture("Agenda large text before collapse", app: app)
        options.tap()
        app.buttons["Collapse all"].tap()
        capture("Agenda large text after collapse", app: app)
        // Every day offers the same global actions. After content shrinks,
        // use a day menu that is clear of the pinned header and floating dock.
        let visibleOptions = app.buttons.matching(NSPredicate(format: "label == %@", "Agenda options"))
            .allElementsBoundByIndex.first {
                $0.isHittable && $0.frame.minY > app.buttons["Map"].frame.maxY && $0.frame.maxY < dock.frame.minY
            }
        XCTAssertNotNil(visibleOptions)
        visibleOptions?.tap()
        XCTAssertTrue(app.buttons["Expand all"].waitForExistence(timeout: 5))
        app.buttons["Expand all"].tap()
        XCTAssertTrue(app.buttons["trip-people-filter"].isHittable)
        XCTAssertTrue(app.buttons["trip-add"].isHittable)
        XCTAssertTrue(app.buttons["Map"].isHittable)
        capture("Agenda large text", app: app)
    }

    @MainActor
    func testDateJumpClearsPinnedControlsAtAccessibilitySize() {
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        app.buttons["Explore a demo trip"].tap()
        let trip = app.buttons["trip-demo-lisbon"]
        XCTAssertTrue(trip.waitForExistence(timeout: 10))
        for _ in 0..<4 where !trip.isHittable { app.swipeUp() }
        trip.tap()
        let options = app.buttons["agenda-options"]
        let dock = app.buttons["trip-tab-more"]
        revealAgendaOptions(options, app: app)
        options.tap()
        XCTAssertTrue(app.buttons["Oct 3, 2026"].waitForExistence(timeout: 5))
        app.buttons["Oct 3, 2026"].tap()
        XCTAssertTrue(options.isHittable)
        XCTAssertGreaterThanOrEqual(options.frame.minY, app.buttons["Map"].frame.maxY)
        XCTAssertLessThan(options.frame.maxY, dock.frame.minY)
        XCTAssertFalse(app.staticTexts["trip-title"].isHittable)
        capture("Date jump below glass", app: app)
        options.tap()
        app.buttons["Collapse all"].tap()
        revealAgendaOptions(options, app: app)
        options.tap()
        app.buttons["Oct 3, 2026"].tap()
        XCTAssertTrue(options.isHittable)
        XCTAssertGreaterThanOrEqual(options.frame.minY, app.buttons["Map"].frame.maxY)
        XCTAssertLessThan(options.frame.maxY, dock.frame.minY)
        capture("Collapsed date jump below glass", app: app)
    }

    @MainActor
    func testCompactCardsOpenDetailsBeforeEditing() {
        let app = openDemoTrip()
        let notes = "A few days of exploring, food and sea air."
        XCTAssertFalse(app.staticTexts[notes].exists)
        XCTAssertFalse(app.staticTexts["Europe/Lisbon"].exists)
        app.buttons["record-destination:demo-destination"].tap()
        XCTAssertTrue(app.staticTexts["record-detail-title"].waitForExistence(timeout: 5))
        app.swipeUp()
        XCTAssertTrue(app.staticTexts[notes].waitForExistence(timeout: 5))
        capture("Plan details", app: app)
        app.buttons["record-edit"].tap()
        XCTAssertTrue(app.textFields["Title"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Save"].exists)
        capture("Plan editor", app: app)
        app.buttons["record-editor-close"].tap()
        app.buttons["record-detail-close"].tap()
    }

    @MainActor
    func testTripIdentityScrollsAwayAndGlassControlsStayReachable() {
        let app = openDemoTrip()
        XCTAssertTrue(app.staticTexts["trip-title"].isHittable)
        let scroll = app.scrollViews["trip-itinerary"]
        scroll.swipeUp()
        scroll.swipeUp()
        capture("Identity after scroll", app: app)
        XCTAssertFalse(app.staticTexts["trip-title"].isHittable)
        XCTAssertFalse(app.staticTexts["trip-dates"].isHittable)
        for name in ["trip-people-filter", "trip-add", "Agenda", "Map", "trip-tab-itinerary", "trip-tab-plan", "trip-tab-people", "trip-tab-more"] {
            XCTAssertTrue(app.buttons[name].isHittable, "Pinned control unavailable: \(name)")
        }
        capture("Pinned glass controls", app: app)
        app.buttons["trip-people-filter"].tap()
        XCTAssertTrue(app.buttons["filter-person-__trip_superuser__"].waitForExistence(timeout: 5))
        app.buttons["filter-person-__trip_superuser__"].tap()
        app.buttons["Done"].tap()
        XCTAssertEqual(app.buttons["trip-people-filter"].value as? String, "1 selected")
    }

    @MainActor
    private func revealAgendaOptions(_ options: XCUIElement, app: XCUIApplication) {
        let scroll = app.scrollViews["trip-itinerary"]
        let dock = app.buttons["trip-tab-more"]
        for _ in 0..<12 {
            let headerBottom = app.buttons["Map"].frame.maxY
            if options.isHittable && options.frame.minY > headerBottom && options.frame.maxY < dock.frame.minY { return }
            // Small drags avoid overshooting the day heading into the pinned bar.
            let moveDown = options.frame.minY <= headerBottom
            let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: moveDown ? 0.35 : 0.75))
            let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
            start.press(forDuration: 0.1, thenDragTo: end)
        }
        XCTAssertGreaterThan(options.frame.minY, app.buttons["Map"].frame.maxY)
        XCTAssertLessThan(options.frame.maxY, dock.frame.minY)
    }

    @MainActor
    private func openDemoTrip() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        app.buttons["Explore a demo trip"].tap()
        let trip = app.buttons["trip-demo-lisbon"]
        XCTAssertTrue(trip.waitForExistence(timeout: 10))
        trip.tap()
        XCTAssertTrue(app.buttons["trip-add"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor
    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
