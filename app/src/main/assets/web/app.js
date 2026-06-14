(() => {
    "use strict";

    const $ = (selector) => document.querySelector(selector);
    const mapEl = $("#map");
    const tileLayer = $("#tile-layer");
    const markerLayer = $("#marker-layer");
    const searchPanel = $("#search-panel");
    const searchInput = $("#search-input");
    const searchClear = $("#search-clear");
    const refreshButton = $("#refresh");
    const locationButton = $("#locate-user");
    const detailSheet = $("#detail-sheet");
    const scrim = $("#scrim");
    const toast = $("#toast");

    const state = {
        center: { lat: 23.75, lon: 121.0 },
        zoom: 7,
        flights: [],
        activeFlights: new Map(),
        tracked: loadTracked(),
        selected: null,
        requestId: 0,
        loading: false,
        active: true,
        userLocation: null,
        locationRequestId: null,
        refreshTimer: null,
        animationTimer: null,
        refreshInterval: 10000,
        moveTimer: null,
        tileElements: new Map(),
        pointers: new Map(),
        gesture: null,
        detailRequestId: null,
        moved: false
    };

    const categoryNames = [
        "未提供", "未分類", "輕型機", "小型機", "大型機", "高尾流大型機",
        "重型機", "高性能飛機", "旋翼機", "滑翔機", "輕於空氣航空器",
        "跳傘人員", "超輕型航空器", "保留", "無人機", "太空航空器",
        "緊急地面車輛", "服務地面車輛", "點狀障礙物", "群組障礙物", "線狀障礙物"
    ];

    const countryNames = {
        "Taiwan": "臺灣",
        "China": "中國",
        "Hong Kong": "香港",
        "Macao": "澳門",
        "Japan": "日本",
        "Republic of Korea": "韓國",
        "South Korea": "韓國",
        "Singapore": "新加坡",
        "Malaysia": "馬來西亞",
        "Thailand": "泰國",
        "Vietnam": "越南",
        "Philippines": "菲律賓",
        "Indonesia": "印尼",
        "United States": "美國",
        "United Kingdom": "英國",
        "France": "法國",
        "Germany": "德國",
        "Canada": "加拿大",
        "Australia": "澳洲",
        "New Zealand": "紐西蘭",
        "United Arab Emirates": "阿拉伯聯合大公國",
        "Qatar": "卡達",
        "Netherlands": "荷蘭",
        "Switzerland": "瑞士",
        "Turkey": "土耳其"
    };

    const planeSvg = `
        <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M18.2 2.5 20.6 13l8.7 5.2-.9 2.6-8.8-2.5-.8 7 3.6 2.8-.5 1.7-5.9-1.5-5.9 1.5-.5-1.7 3.6-2.8-.8-7-8.8 2.5-.9-2.6 8.7-5.2 2.4-10.5c.4-1.8 4-1.8 4.4 0Z"/>
        </svg>`;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function project(lat, lon, zoom = state.zoom) {
        const size = 256 * Math.pow(2, zoom);
        const safeLat = clamp(lat, -85.0511, 85.0511);
        const sin = Math.sin(safeLat * Math.PI / 180);
        return {
            x: (lon + 180) / 360 * size,
            y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
        };
    }

    function unproject(x, y, zoom = state.zoom) {
        const size = 256 * Math.pow(2, zoom);
        const n = Math.PI - 2 * Math.PI * y / size;
        return {
            lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
            lon: x / size * 360 - 180
        };
    }

    function getViewportBounds() {
        const center = project(state.center.lat, state.center.lon);
        const halfWidth = mapEl.clientWidth / 2;
        const halfHeight = mapEl.clientHeight / 2;
        const nw = unproject(center.x - halfWidth, center.y - halfHeight);
        const se = unproject(center.x + halfWidth, center.y + halfHeight);
        return {
            south: clamp(se.lat, -85, 85),
            west: clamp(nw.lon, -180, 180),
            north: clamp(nw.lat, -85, 85),
            east: clamp(se.lon, -180, 180)
        };
    }

    function renderMap() {
        renderTiles();
        renderMarkers();
    }

    function renderTiles() {
        const tileZoom = Math.floor(state.zoom);
        const tileScale = Math.pow(2, state.zoom - tileZoom);
        const tileSize = 256 * tileScale;
        const count = Math.pow(2, tileZoom);
        const center = project(state.center.lat, state.center.lon);
        const left = center.x - mapEl.clientWidth / 2;
        const top = center.y - mapEl.clientHeight / 2;
        const firstX = Math.floor(left / tileSize);
        const lastX = Math.floor((left + mapEl.clientWidth) / tileSize);
        const firstY = Math.floor(top / tileSize);
        const lastY = Math.floor((top + mapEl.clientHeight) / tileSize);
        const visible = new Set();

        for (let x = firstX; x <= lastX; x += 1) {
            for (let y = firstY; y <= lastY; y += 1) {
                if (y < 0 || y >= count) continue;
                const wrappedX = ((x % count) + count) % count;
                const key = `${tileZoom}/${wrappedX}/${y}/${x}`;
                visible.add(key);
                let tile = state.tileElements.get(key);
                if (!tile) {
                    tile = new Image();
                    tile.className = "tile";
                    tile.alt = "";
                    tile.draggable = false;
                    tile.decoding = "async";
                    tile.src = `https://tile.openstreetmap.org/${tileZoom}/${wrappedX}/${y}.png`;
                    tileLayer.appendChild(tile);
                    state.tileElements.set(key, tile);
                }
                tile.style.width = `${tileSize + 0.5}px`;
                tile.style.height = `${tileSize + 0.5}px`;
                tile.style.left = `${x * tileSize - left}px`;
                tile.style.top = `${y * tileSize - top}px`;
            }
        }

        for (const [key, tile] of state.tileElements) {
            if (!visible.has(key)) {
                tile.remove();
                state.tileElements.delete(key);
            }
        }
    }

    function renderMarkers() {
        markerLayer.replaceChildren();
        const center = project(state.center.lat, state.center.lon);
        const width = mapEl.clientWidth;
        const height = mapEl.clientHeight;

        for (const flight of state.flights) {
            if (flight.latitude == null || flight.longitude == null) continue;
            const position = estimateFlightPosition(flight);
            const point = project(position.latitude, position.longitude);
            const left = point.x - center.x + width / 2;
            const top = point.y - center.y + height / 2;
            if (left < -25 || top < -25 || left > width + 25 || top > height + 25) continue;

            const marker = document.createElement("button");
            marker.className = "plane-marker";
            if (flight.onGround) marker.classList.add("on-ground");
            if (state.tracked.has(flight.icao24)) marker.classList.add("tracked");
            marker.style.left = `${left}px`;
            marker.style.top = `${top}px`;
            marker.style.transform = `translate(-50%, -50%) rotate(${flight.heading || 0}deg)`;
            marker.setAttribute("aria-label", `查看 ${displayCallsign(flight)} 詳情`);
            marker.innerHTML = planeSvg;
            marker.addEventListener("click", (event) => {
                event.stopPropagation();
                openDetail(flight);
            });
            markerLayer.appendChild(marker);
        }
        renderUserLocation(center, width, height);
    }

    function estimateFlightPosition(flight) {
        if (flight.onGround
            || flight.velocity == null
            || flight.heading == null
            || !flight.timePosition) {
            return { latitude: flight.latitude, longitude: flight.longitude };
        }
        const elapsed = clamp(Date.now() / 1000 - flight.timePosition, 0, 25);
        const distance = flight.velocity * elapsed;
        const angularDistance = distance / 6371000;
        const bearing = flight.heading * Math.PI / 180;
        const latitude = flight.latitude * Math.PI / 180;
        const longitude = flight.longitude * Math.PI / 180;
        const estimatedLatitude = Math.asin(
            Math.sin(latitude) * Math.cos(angularDistance)
            + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
        );
        const estimatedLongitude = longitude + Math.atan2(
            Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
            Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(estimatedLatitude)
        );
        return {
            latitude: estimatedLatitude * 180 / Math.PI,
            longitude: estimatedLongitude * 180 / Math.PI
        };
    }

    function renderUserLocation(center, width, height) {
        if (!state.userLocation) return;
        const point = project(state.userLocation.latitude, state.userLocation.longitude);
        const left = point.x - center.x + width / 2;
        const top = point.y - center.y + height / 2;
        if (left < -180 || top < -180 || left > width + 180 || top > height + 180) return;

        const metersPerPixel = 156543.03392
            * Math.cos(state.userLocation.latitude * Math.PI / 180)
            / Math.pow(2, state.zoom);
        const diameter = clamp(
            state.userLocation.accuracy * 2 / Math.max(metersPerPixel, 0.1),
            30,
            300
        );
        const marker = document.createElement("div");
        marker.className = "user-location";
        marker.style.left = `${left}px`;
        marker.style.top = `${top}px`;
        marker.innerHTML = `
            <span class="user-accuracy" style="width:${diameter}px;height:${diameter}px"></span>
            <span class="user-dot"></span>`;
        markerLayer.appendChild(marker);
    }

    function normalizeFlight(row) {
        return {
            icao24: String(row[0] || "").trim().toLowerCase(),
            callsign: String(row[1] || "").trim(),
            country: String(row[2] || "未知"),
            timePosition: row[3],
            lastContact: row[4],
            longitude: row[5],
            latitude: row[6],
            altitude: row[7],
            onGround: Boolean(row[8]),
            velocity: row[9],
            heading: row[10],
            verticalRate: row[11],
            geoAltitude: row[13],
            squawk: row[14],
            category: row[17] == null ? 0 : row[17]
        };
    }

    function requestFlights(query = "") {
        if (state.loading || !state.active) return;
        state.loading = true;
        state.requestId += 1;
        const requestId = String(state.requestId);
        const bounds = getViewportBounds();
        refreshButton.classList.add("loading");
        setLiveState("loading");

        if (window.SkyTrackAndroid && typeof window.SkyTrackAndroid.requestFlights === "function") {
            window.SkyTrackAndroid.requestFlights(
                requestId,
                bounds.south,
                bounds.west,
                bounds.north,
                bounds.east,
                query
            );
            return;
        }

        window.setTimeout(() => {
            const demo = demoFlights();
            receiveFlights(requestId, JSON.stringify({ time: Date.now() / 1000, states: demo }), query, -1);
            showToast("瀏覽器預覽模式：目前顯示示範航班");
        }, 500);
    }

    function receiveFlights(requestId, rawJson, query, remaining) {
        if (Number(requestId) !== state.requestId) return;
        state.loading = false;
        refreshButton.classList.remove("loading");
        setLiveState("live");

        try {
            const payload = JSON.parse(rawJson);
            const incoming = Array.isArray(payload.states)
                ? payload.states.map(normalizeFlight).filter((flight) => flight.icao24 && flight.latitude != null && flight.longitude != null)
                : [];

            incoming.forEach((flight) => {
                state.activeFlights.set(flight.icao24, flight);
                if (state.tracked.has(flight.icao24)) {
                    state.tracked.set(flight.icao24, flight);
                }
            });
            saveTracked();

            if (query) {
                const needle = query.trim().toUpperCase();
                const matches = incoming.filter((flight) =>
                    flight.callsign.toUpperCase().includes(needle)
                    || flight.icao24.toUpperCase().includes(needle)
                );
                showSearchResults(query, matches);
            } else {
                state.flights = incoming;
                renderMap();
                $("#flight-count").textContent = `${incoming.length} 架航機`;
                hideSearchResults();
            }
            renderWatchList();
            if (remaining >= 0) {
                $("#flight-count").title = `OpenSky 剩餘額度：${remaining}`;
                state.refreshInterval = remaining <= 20 ? 60000 : remaining <= 100 ? 30000 : 10000;
            }
            $("#updated-at").textContent =
                `${formatClock(payload.time ? payload.time * 1000 : Date.now())} · ${state.refreshInterval / 1000}秒`;
            scheduleRefresh(state.refreshInterval);
        } catch (error) {
            receiveError(requestId, "航班資料格式錯誤", -1, 0);
        }
    }

    function receiveError(requestId, message, status, retryAfter) {
        if (Number(requestId) !== state.requestId) return;
        state.loading = false;
        refreshButton.classList.remove("loading");
        setLiveState("error");
        const suffix = status === 429 && retryAfter > 0
            ? `，約 ${Math.ceil(retryAfter / 60)} 分鐘後恢復`
            : "";
        showToast(message + suffix);
        scheduleRefresh(status === 429 ? Math.max(retryAfter * 1000, 60000) : 60000);
    }

    function showSearchResults(query, flights) {
        $("#search-title").textContent = `「${query}」`;
        $("#search-count").textContent = flights.length;
        const list = $("#search-results");
        list.replaceChildren();

        if (!flights.length) {
            list.innerHTML = `<div class="result-empty">找不到符合的即時航班。<br>請確認航班代號，或輸入 6 碼 ICAO24。</div>`;
        } else {
            flights.slice(0, 60).forEach((flight) => {
                const item = document.createElement("button");
                item.className = "result-item";
                item.innerHTML = `
                    <span class="result-plane">${planeSvg}</span>
                    <span class="result-copy">
                        <strong>${escapeHtml(displayCallsign(flight))}</strong>
                        <span>${escapeHtml(displayCountry(flight.country))} · ${formatAltitude(flight.altitude)} 英尺</span>
                    </span>
                    <svg><use href="#icon-arrow"></use></svg>`;
                item.addEventListener("click", () => {
                    state.center = { lat: flight.latitude, lon: flight.longitude };
                    state.zoom = Math.max(state.zoom, 8);
                    state.flights = mergeFlights(state.flights, flights);
                    hideSearchResults();
                    renderMap();
                    openDetail(flight);
                });
                list.appendChild(item);
            });
        }
        searchPanel.classList.remove("hidden");
    }

    function hideSearchResults() {
        searchPanel.classList.add("hidden");
    }

    function openDetail(flight) {
        state.selected = flight;
        resetExtendedDetail();
        $("#detail-callsign").textContent = displayCallsign(flight);
        $("#detail-country").textContent = displayCountry(flight.country);
        $("#detail-icao").textContent = `ICAO24 ${flight.icao24.toUpperCase()}`;
        $("#detail-plane").innerHTML = planeSvg;
        $("#detail-plane svg").style.transform = `rotate(${flight.heading || 0}deg)`;
        $("#detail-altitude").textContent = formatNumber(metersToFeet(flight.altitude));
        $("#detail-speed").textContent = formatNumber(msToKnots(flight.velocity));
        $("#detail-heading").textContent = flight.heading == null ? "--" : Math.round(flight.heading);
        $("#detail-vertical").textContent = signedNumber(msToFeetPerMinute(flight.verticalRate));
        $("#detail-category").textContent = categoryNames[flight.category] || "其他";
        $("#detail-squawk").textContent = flight.squawk || "--";
        $("#detail-coordinates").textContent = `${flight.latitude.toFixed(3)}, ${flight.longitude.toFixed(3)}`;
        $("#detail-contact").textContent = flight.lastContact ? relativeTime(flight.lastContact * 1000) : "--";
        const status = $("#detail-status");
        status.textContent = flight.onGround ? "地面滑行 / 停留" : getVerticalStatus(flight.verticalRate);
        status.classList.toggle("ground", flight.onGround);
        updateTrackButton();
        detailSheet.classList.add("open");
        detailSheet.setAttribute("aria-hidden", "false");
        scrim.classList.remove("hidden");
        requestFlightDetails(flight);
    }

    function resetExtendedDetail() {
        $("#detail-departure").textContent = "--";
        $("#detail-arrival").textContent = "--";
        $("#detail-departure-time").textContent = "正在取得詳細資料";
        $("#detail-arrival-time").textContent = "正在取得詳細資料";
        $("#detail-flight-number").textContent = "--";
        $("#detail-aircraft").textContent = "--";
        $("#detail-gate").textContent = "--";
        $("#detail-delay").textContent = "--";
    }

    function requestFlightDetails(flight) {
        state.detailRequestId = `detail-${flight.icao24}-${Date.now()}`;
        if (window.SkyTrackAndroid
            && typeof window.SkyTrackAndroid.requestFlightDetails === "function") {
            window.SkyTrackAndroid.requestFlightDetails(
                state.detailRequestId,
                flight.icao24,
                flight.callsign
            );
            return;
        }
        receiveFlightDetailError(state.detailRequestId, "瀏覽器預覽無法查詢 AirLabs");
    }

    function receiveFlightDetails(requestId, rawJson) {
        if (requestId !== state.detailRequestId || !state.selected) return;
        try {
            const payload = JSON.parse(rawJson);
            const live = payload.live || {};
            const schedule = payload.schedule || {};
            const departure = schedule.dep_iata || live.dep_iata || schedule.dep_icao || live.dep_icao;
            const arrival = schedule.arr_iata || live.arr_iata || schedule.arr_icao || live.arr_icao;
            $("#detail-departure").textContent = departure || "--";
            $("#detail-arrival").textContent = arrival || "--";
            $("#detail-departure-time").textContent = formatFlightTime(
                schedule.dep_actual || schedule.dep_estimated || schedule.dep_time
            );
            $("#detail-arrival-time").textContent = formatFlightTime(
                schedule.arr_actual || schedule.arr_estimated || schedule.arr_time
            );
            $("#detail-flight-number").textContent =
                live.flight_iata || schedule.flight_iata || live.flight_icao
                || schedule.flight_icao || displayCallsign(state.selected);
            $("#detail-aircraft").textContent = joinValues(
                live.aircraft_icao || schedule.aircraft_icao,
                live.reg_number
            );
            $("#detail-gate").textContent = formatGate(schedule);
            const delay = Math.max(
                Number(schedule.dep_delayed || 0),
                Number(schedule.arr_delayed || 0)
            );
            $("#detail-delay").textContent = delay > 0 ? `${delay} 分鐘` : "目前無延誤資訊";
            const status = translateFlightStatus(live.status || schedule.status);
            if (status) $("#detail-status").textContent = status;
        } catch (_) {
            receiveFlightDetailError(requestId, "詳細資料格式錯誤");
        }
    }

    function receiveFlightDetailError(requestId, message) {
        if (requestId !== state.detailRequestId) return;
        $("#detail-departure-time").textContent = "暫無資料";
        $("#detail-arrival-time").textContent = "暫無資料";
        $("#detail-flight-number").textContent = message;
    }

    function closeDetail() {
        detailSheet.classList.remove("open");
        detailSheet.setAttribute("aria-hidden", "true");
        scrim.classList.add("hidden");
        state.selected = null;
        state.detailRequestId = null;
    }

    function toggleTracked() {
        if (!state.selected) return;
        const key = state.selected.icao24;
        if (state.tracked.has(key)) {
            state.tracked.delete(key);
            showToast(`${displayCallsign(state.selected)} 已移除追蹤`);
        } else {
            state.tracked.set(key, state.selected);
            showToast(`${displayCallsign(state.selected)} 已加入追蹤`);
        }
        saveTracked();
        updateTrackButton();
        updateWatchBadge();
        renderWatchList();
        renderMarkers();
    }

    function updateTrackButton() {
        const button = $("#track-button");
        const tracked = state.selected && state.tracked.has(state.selected.icao24);
        button.classList.toggle("tracked", Boolean(tracked));
        button.querySelector("span").textContent = tracked ? "取消追蹤" : "加入追蹤";
    }

    function renderWatchList() {
        const list = $("#watch-list");
        const empty = $("#watch-empty");
        list.replaceChildren();
        const flights = [...state.tracked.values()];
        empty.classList.toggle("hidden", flights.length > 0);
        list.classList.toggle("hidden", flights.length === 0);

        flights.forEach((flight) => {
            const card = document.createElement("article");
            card.className = "watch-card";
            card.innerHTML = `
                <div>
                    <small>${escapeHtml(displayCountry(flight.country))}</small>
                    <h3>${escapeHtml(displayCallsign(flight))}</h3>
                    <p>ICAO24 ${escapeHtml(flight.icao24.toUpperCase())}</p>
                </div>
                <span class="watch-card-status">${flight.onGround ? "地面" : "飛行中"}</span>
                <div class="watch-metrics">
                    <div><span>高度</span><strong>${formatAltitude(flight.altitude)} 英尺</strong></div>
                    <div><span>地速</span><strong>${formatNumber(msToKnots(flight.velocity))} 節</strong></div>
                    <div><span>更新</span><strong>${flight.lastContact ? relativeTime(flight.lastContact * 1000) : "--"}</strong></div>
                </div>
                <button class="watch-open">查看航班詳情</button>`;
            card.querySelector(".watch-open").addEventListener("click", () => openDetail(flight));
            list.appendChild(card);
        });
        updateWatchBadge();
    }

    function switchScreen(name) {
        document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
        document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.screen === name));
        $(`#${name}-screen`).classList.add("active");
        if (name === "map") {
            window.setTimeout(renderMap, 30);
        } else {
            renderWatchList();
        }
    }

    function scheduleRefresh(delay = state.refreshInterval) {
        window.clearTimeout(state.refreshTimer);
        if (!state.active) return;
        state.refreshTimer = window.setTimeout(() => requestFlights(), delay);
    }

    function setActive(active) {
        state.active = active;
        if (active) {
            scheduleRefresh(1000);
            startAnimation();
        } else {
            window.clearTimeout(state.refreshTimer);
            stopAnimation();
        }
    }

    function startAnimation() {
        stopAnimation();
        state.animationTimer = window.setInterval(() => {
            if (state.active && $("#map-screen").classList.contains("active")) {
                renderMarkers();
            }
        }, 1000);
    }

    function stopAnimation() {
        window.clearInterval(state.animationTimer);
        state.animationTimer = null;
    }

    function setLiveState(mode) {
        const pill = $("#live-pill");
        pill.classList.toggle("error", mode === "error");
        pill.lastChild.textContent = mode === "loading" ? " 更新中" : mode === "error" ? " 離線" : " 即時";
    }

    function handleBack() {
        if (detailSheet.classList.contains("open")) {
            closeDetail();
            return true;
        }
        if (!searchPanel.classList.contains("hidden")) {
            clearSearch();
            return true;
        }
        if ($("#watch-screen").classList.contains("active")) {
            switchScreen("map");
            return true;
        }
        return false;
    }

    function clearSearch() {
        searchInput.value = "";
        searchClear.classList.add("hidden");
        hideSearchResults();
        searchInput.blur();
    }

    function locateUser() {
        if (state.locationRequestId) return;
        state.locationRequestId = `location-${Date.now()}`;
        locationButton.classList.add("locating");

        if (window.SkyTrackAndroid
            && typeof window.SkyTrackAndroid.requestCurrentLocation === "function") {
            window.SkyTrackAndroid.requestCurrentLocation(state.locationRequestId);
            return;
        }

        if (!navigator.geolocation) {
            receiveLocationError(state.locationRequestId, "此裝置不支援定位功能");
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => receiveCurrentLocation(
                state.locationRequestId,
                position.coords.latitude,
                position.coords.longitude,
                position.coords.accuracy
            ),
            () => receiveLocationError(state.locationRequestId, "無法取得目前位置"),
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 }
        );
    }

    function receiveCurrentLocation(requestId, latitude, longitude, accuracy) {
        if (requestId !== state.locationRequestId) return;
        state.locationRequestId = null;
        locationButton.classList.remove("locating");
        state.userLocation = { latitude, longitude, accuracy: accuracy || 50 };
        state.center = { lat: latitude, lon: longitude };
        state.zoom = Math.max(state.zoom, 11);
        state.tileElements.forEach((tile) => tile.remove());
        state.tileElements.clear();
        renderMap();
        showToast(`已定位到目前位置，精度約 ${Math.round(accuracy || 50)} 公尺`);
        window.clearTimeout(state.moveTimer);
        state.moveTimer = window.setTimeout(() => requestFlights(), 400);
    }

    function receiveLocationError(requestId, message) {
        if (requestId !== state.locationRequestId) return;
        state.locationRequestId = null;
        locationButton.classList.remove("locating");
        showToast(message);
    }

    function showToast(message) {
        toast.textContent = message;
        toast.classList.remove("hidden");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 2800);
    }

    function loadTracked() {
        try {
            const values = JSON.parse(localStorage.getItem("skytrack.tracked") || "[]");
            return new Map(values.map((flight) => [flight.icao24, flight]));
        } catch (_) {
            return new Map();
        }
    }

    function saveTracked() {
        localStorage.setItem("skytrack.tracked", JSON.stringify([...state.tracked.values()]));
    }

    function updateWatchBadge() {
        const badge = $("#watch-badge");
        badge.textContent = state.tracked.size;
        badge.classList.toggle("hidden", state.tracked.size === 0);
    }

    function displayCallsign(flight) {
        return flight.callsign || flight.icao24.toUpperCase();
    }

    function displayCountry(country) {
        if (!country) return "未知來源";
        return countryNames[country] || country;
    }

    function metersToFeet(value) {
        return value == null ? null : value * 3.28084;
    }

    function msToKnots(value) {
        return value == null ? null : value * 1.94384;
    }

    function msToFeetPerMinute(value) {
        return value == null ? null : value * 196.8504;
    }

    function formatAltitude(value) {
        return formatNumber(metersToFeet(value));
    }

    function formatNumber(value) {
        return value == null || Number.isNaN(value) ? "--" : Math.round(value).toLocaleString("zh-TW");
    }

    function signedNumber(value) {
        if (value == null || Number.isNaN(value)) return "--";
        const rounded = Math.round(value);
        return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("zh-TW")}`;
    }

    function formatClock(value) {
        return new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
    }

    function relativeTime(value) {
        const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
        if (seconds < 5) return "剛剛";
        if (seconds < 60) return `${seconds} 秒前`;
        return `${Math.round(seconds / 60)} 分鐘前`;
    }

    function formatFlightTime(value) {
        if (!value) return "暫無時間";
        const text = String(value);
        return text.length >= 16 ? text.slice(5, 16).replace("-", "/") : text;
    }

    function formatGate(schedule) {
        const departure = joinValues(schedule.dep_terminal, schedule.dep_gate);
        const arrival = joinValues(schedule.arr_terminal, schedule.arr_gate);
        if (departure === "--" && arrival === "--") return "--";
        return `出發 ${departure}／抵達 ${arrival}`;
    }

    function joinValues(first, second) {
        const values = [first, second].filter((value) => value != null && String(value).trim());
        return values.length ? values.join(" · ") : "--";
    }

    function translateFlightStatus(status) {
        return ({
            "scheduled": "預定",
            "en-route": "飛行中",
            "active": "飛行中",
            "landed": "已抵達",
            "cancelled": "已取消"
        })[status] || "";
    }

    function getVerticalStatus(rate) {
        if (rate == null || Math.abs(rate) < 0.5) return "平飛中";
        return rate > 0 ? "爬升中" : "下降中";
    }

    function mergeFlights(current, incoming) {
        const merged = new Map(current.map((flight) => [flight.icao24, flight]));
        incoming.forEach((flight) => merged.set(flight.icao24, flight));
        return [...merged.values()];
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
        })[char]);
    }

    function demoFlights() {
        const now = Math.floor(Date.now() / 1000);
        return [
            ["8990a1", "EVA215", "Taiwan", now, now, 121.22, 24.18, 9144, false, 238, 32, 2.1, null, 9390, "3122", false, 0, 4],
            ["8991b2", "CAL101", "Taiwan", now, now, 120.95, 23.45, 10972, false, 252, 188, -1.4, null, 11200, "5210", false, 0, 4],
            ["7802c3", "CPA421", "Hong Kong", now, now, 121.7, 22.95, 10363, false, 246, 5, 0.1, null, 10600, "1134", false, 0, 6],
            ["71be44", "KAL691", "Republic of Korea", now, now, 120.32, 24.74, 8229, false, 221, 151, -3.3, null, 8460, "2217", false, 0, 4],
            ["8995e5", "TTW718", "Taiwan", now, now, 121.55, 25.08, 580, false, 108, 287, -2.5, null, 640, "4301", false, 0, 3]
        ];
    }

    function pointerMidpoint() {
        const values = [...state.pointers.values()];
        if (values.length < 2) return null;
        return {
            x: (values[0].x + values[1].x) / 2,
            y: (values[0].y + values[1].y) / 2
        };
    }

    function pointerDistance() {
        const values = [...state.pointers.values()];
        if (values.length < 2) return 0;
        return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
    }

    function geoAtScreenPoint(point, zoom = state.zoom) {
        const center = project(state.center.lat, state.center.lon, zoom);
        return unproject(
            center.x + point.x - mapEl.clientWidth / 2,
            center.y + point.y - mapEl.clientHeight / 2,
            zoom
        );
    }

    mapEl.addEventListener("pointerdown", (event) => {
        if (event.target.closest(".plane-marker")) return;
        mapEl.setPointerCapture(event.pointerId);
        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (state.pointers.size === 1) {
            state.gesture = {
                type: "drag",
                x: event.clientX,
                y: event.clientY,
                center: project(state.center.lat, state.center.lon)
            };
        } else if (state.pointers.size === 2) {
            const midpoint = pointerMidpoint();
            state.gesture = {
                type: "pinch",
                startDistance: pointerDistance(),
                startZoom: state.zoom,
                anchor: geoAtScreenPoint(midpoint)
            };
        }
        state.moved = false;
    });

    mapEl.addEventListener("pointermove", (event) => {
        if (!state.pointers.has(event.pointerId) || !state.gesture) return;
        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (state.gesture.type === "pinch" && state.pointers.size >= 2) {
            const distance = Math.max(pointerDistance(), 1);
            const targetZoom = clamp(
                state.gesture.startZoom + Math.log2(distance / state.gesture.startDistance),
                3,
                13
            );
            const midpoint = pointerMidpoint();
            const anchorWorld = project(
                state.gesture.anchor.lat,
                state.gesture.anchor.lon,
                targetZoom
            );
            state.zoom = targetZoom;
            state.center = unproject(
                anchorWorld.x - midpoint.x + mapEl.clientWidth / 2,
                anchorWorld.y - midpoint.y + mapEl.clientHeight / 2,
                targetZoom
            );
            state.moved = true;
        } else if (state.gesture.type === "drag" && state.pointers.size === 1) {
            const dx = event.clientX - state.gesture.x;
            const dy = event.clientY - state.gesture.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
            state.center = unproject(state.gesture.center.x - dx, state.gesture.center.y - dy);
        }
        state.center.lat = clamp(state.center.lat, -84, 84);
        state.center.lon = clamp(state.center.lon, -180, 180);
        renderMap();
    });

    function finishMove(event) {
        if (!state.pointers.has(event.pointerId)) return;
        state.pointers.delete(event.pointerId);
        if (state.pointers.size === 1) {
            const remaining = [...state.pointers.values()][0];
            state.gesture = {
                type: "drag",
                x: remaining.x,
                y: remaining.y,
                center: project(state.center.lat, state.center.lon)
            };
        } else if (state.pointers.size === 0) {
            state.gesture = null;
        }
        if (state.moved && state.pointers.size === 0) {
            window.clearTimeout(state.moveTimer);
            state.tileElements.forEach((tile) => tile.remove());
            state.tileElements.clear();
            renderMap();
            state.moveTimer = window.setTimeout(() => requestFlights(), 700);
        }
    }

    mapEl.addEventListener("pointerup", finishMove);
    mapEl.addEventListener("pointercancel", finishMove);
    mapEl.addEventListener("dblclick", () => changeZoom(1));
    mapEl.addEventListener("wheel", (event) => {
        event.preventDefault();
        changeZoom(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    function changeZoom(delta) {
        const next = clamp(state.zoom + delta, 3, 13);
        if (next === state.zoom) return;
        state.zoom = next;
        state.tileElements.forEach((tile) => tile.remove());
        state.tileElements.clear();
        renderMap();
        window.clearTimeout(state.moveTimer);
        state.moveTimer = window.setTimeout(() => requestFlights(), 700);
    }

    $("#zoom-in").addEventListener("click", () => changeZoom(1));
    $("#zoom-out").addEventListener("click", () => changeZoom(-1));
    locationButton.addEventListener("click", locateUser);
    refreshButton.addEventListener("click", () => requestFlights());
    $("#detail-close").addEventListener("click", closeDetail);
    scrim.addEventListener("click", closeDetail);
    $("#track-button").addEventListener("click", toggleTracked);
    searchClear.addEventListener("click", clearSearch);
    $("#empty-map-button").addEventListener("click", () => switchScreen("map"));

    $("#search-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const query = searchInput.value.trim();
        if (query.length < 2) {
            showToast("請輸入至少 2 個字元");
            return;
        }
        searchInput.blur();
        requestFlights(query);
    });

    searchInput.addEventListener("input", () => {
        searchClear.classList.toggle("hidden", !searchInput.value);
        if (!searchInput.value) hideSearchResults();
    });

    document.querySelectorAll(".nav-item").forEach((button) => {
        button.addEventListener("click", () => switchScreen(button.dataset.screen));
    });

    window.addEventListener("resize", renderMap);

    window.SkyTrack = {
        receiveFlights,
        receiveError,
        receiveCurrentLocation,
        receiveLocationError,
        receiveFlightDetails,
        receiveFlightDetailError,
        setActive,
        handleBack
    };

    renderMap();
    renderWatchList();
    startAnimation();
    window.setTimeout(() => requestFlights(), 350);
})();
