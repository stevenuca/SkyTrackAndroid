package com.skytrack.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressWarnings("deprecation")
public class MainActivity extends Activity {
    private static final int LOCATION_PERMISSION_REQUEST = 1001;
    private static final String OPENSKY_ENDPOINT = "https://opensky-network.org/api/states/all";
    private static final String AIRLABS_FLIGHTS_ENDPOINT = "https://airlabs.co/api/v9/flights";
    private static final String AIRLABS_SCHEDULES_ENDPOINT = "https://airlabs.co/api/v9/schedules";
    private static final long DETAIL_CACHE_TTL_MS = 10 * 60 * 1000L;
    private static final String USER_AGENT = "SkyTrackAndroid/1.0 (personal flight tracker)";

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Map<String, CachedFlightDetail> flightDetailCache = new ConcurrentHashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private LocationManager locationManager;
    private LocationListener activeLocationListener;
    private String pendingLocationRequestId;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(7, 17, 31));
        getWindow().setNavigationBarColor(Color.rgb(7, 17, 31));

        webView = new WebView(this);
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        webView.setBackgroundColor(Color.rgb(7, 17, 31));
        webView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        setContentView(webView);

        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setDatabaseEnabled(true);
        webView.getSettings().setUserAgentString(USER_AGENT);
        webView.getSettings().setAllowFileAccess(true);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.addJavascriptInterface(new FlightBridge(), "SkyTrackAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme())) {
                    return false;
                }
                if ("https".equals(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }
                return true;
            }
        });
        webView.loadUrl("file:///android_asset/web/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript("window.SkyTrack && window.SkyTrack.setActive(true)", null);
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript("window.SkyTrack && window.SkyTrack.setActive(false)", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                "window.SkyTrack && window.SkyTrack.handleBack()",
                value -> {
                    if (!"true".equals(value)) {
                        MainActivity.super.onBackPressed();
                    }
                }
            );
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        stopLocationRequest();
        networkExecutor.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("SkyTrackAndroid");
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        String[] permissions,
        int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != LOCATION_PERMISSION_REQUEST || pendingLocationRequestId == null) {
            return;
        }
        if (hasLocationPermission()) {
            requestSingleLocation(pendingLocationRequestId);
        } else {
            sendLocationError(pendingLocationRequestId, "未授權位置權限，無法顯示你的位置");
            pendingLocationRequestId = null;
        }
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private final class FlightBridge {
        @JavascriptInterface
        public void requestFlights(
            String requestId,
            double south,
            double west,
            double north,
            double east,
            String query
        ) {
            networkExecutor.execute(() -> fetchFlights(
                requestId,
                clamp(south, -85, 85),
                clamp(west, -180, 180),
                clamp(north, -85, 85),
                clamp(east, -180, 180),
                query == null ? "" : query.trim()
            ));
        }

        @JavascriptInterface
        public void requestCurrentLocation(String requestId) {
            runOnUiThread(() -> beginLocationRequest(
                requestId == null ? "" : requestId.trim()
            ));
        }

        @JavascriptInterface
        public void requestFlightDetails(String requestId, String icao24, String callsign) {
            networkExecutor.execute(() -> fetchFlightDetails(
                requestId == null ? "" : requestId.trim(),
                icao24 == null ? "" : icao24.trim().toLowerCase(Locale.US),
                callsign == null ? "" : callsign.trim().toUpperCase(Locale.US)
            ));
        }
    }

    private void beginLocationRequest(String requestId) {
        pendingLocationRequestId = requestId;
        if (hasLocationPermission()) {
            requestSingleLocation(requestId);
            return;
        }
        requestPermissions(
            new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            },
            LOCATION_PERMISSION_REQUEST
        );
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressLint("MissingPermission")
    private void requestSingleLocation(String requestId) {
        stopLocationRequest();
        pendingLocationRequestId = requestId;

        String provider = chooseLocationProvider();
        if (provider == null) {
            sendLocationError(requestId, "請先開啟手機的定位服務");
            pendingLocationRequestId = null;
            return;
        }

        Location cached = findBestLastKnownLocation();
        if (cached != null && System.currentTimeMillis() - cached.getTime() < 300_000) {
            sendLocationSuccess(requestId, cached);
            pendingLocationRequestId = null;
            return;
        }

        activeLocationListener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (!requestId.equals(pendingLocationRequestId)) {
                    return;
                }
                sendLocationSuccess(requestId, location);
                pendingLocationRequestId = null;
                stopLocationRequest();
            }
        };

        try {
            locationManager.requestSingleUpdate(
                provider,
                activeLocationListener,
                Looper.getMainLooper()
            );
            mainHandler.postDelayed(() -> {
                if (!requestId.equals(pendingLocationRequestId)) {
                    return;
                }
                Location fallback = findBestLastKnownLocation();
                if (fallback != null) {
                    sendLocationSuccess(requestId, fallback);
                } else {
                    sendLocationError(requestId, "暫時無法取得位置，請到戶外後再試");
                }
                pendingLocationRequestId = null;
                stopLocationRequest();
            }, 15_000);
        } catch (SecurityException error) {
            sendLocationError(requestId, "需要位置權限才能使用定位功能");
            pendingLocationRequestId = null;
        }
    }

    private String chooseLocationProvider() {
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                return LocationManager.GPS_PROVIDER;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                return LocationManager.NETWORK_PROVIDER;
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }

    @SuppressLint("MissingPermission")
    private Location findBestLastKnownLocation() {
        Location best = null;
        try {
            for (String provider : locationManager.getProviders(true)) {
                Location candidate = locationManager.getLastKnownLocation(provider);
                if (candidate == null) {
                    continue;
                }
                if (best == null
                    || candidate.getTime() > best.getTime()
                    || candidate.getAccuracy() < best.getAccuracy()) {
                    best = candidate;
                }
            }
        } catch (SecurityException ignored) {
            return null;
        }
        return best;
    }

    private void stopLocationRequest() {
        mainHandler.removeCallbacksAndMessages(null);
        if (activeLocationListener != null && locationManager != null) {
            try {
                locationManager.removeUpdates(activeLocationListener);
            } catch (SecurityException ignored) {
                // Permission may have been revoked while the request was active.
            }
        }
        activeLocationListener = null;
    }

    private void sendLocationSuccess(String requestId, Location location) {
        String script = String.format(
            Locale.US,
            "window.SkyTrack.receiveCurrentLocation(%s,%.7f,%.7f,%.1f)",
            JSONObject.quote(requestId),
            location.getLatitude(),
            location.getLongitude(),
            location.getAccuracy()
        );
        runJavascript(script);
    }

    private void sendLocationError(String requestId, String message) {
        String script = "window.SkyTrack.receiveLocationError("
            + JSONObject.quote(requestId) + ","
            + JSONObject.quote(message) + ")";
        runJavascript(script);
    }

    private void fetchFlights(
        String requestId,
        double south,
        double west,
        double north,
        double east,
        String query
    ) {
        if (!isNetworkAvailable()) {
            sendError(requestId, "目前沒有網路連線", -1, 0);
            return;
        }

        HttpURLConnection connection = null;
        try {
            String requestUrl;
            if (query.matches("(?i)^[0-9a-f]{6}$")) {
                requestUrl = OPENSKY_ENDPOINT + "?extended=1&icao24="
                    + URLEncoder.encode(query.toLowerCase(Locale.US), "UTF-8");
            } else if (!query.isEmpty()) {
                requestUrl = OPENSKY_ENDPOINT + "?extended=1";
            } else {
                requestUrl = String.format(
                    Locale.US,
                    "%s?extended=1&lamin=%.5f&lomin=%.5f&lamax=%.5f&lomax=%.5f",
                    OPENSKY_ENDPOINT,
                    south,
                    west,
                    north,
                    east
                );
            }

            connection = (HttpURLConnection) new URL(requestUrl).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(18_000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", USER_AGENT);

            int status = connection.getResponseCode();
            int remaining = parseIntHeader(connection, "X-Rate-Limit-Remaining");
            int retryAfter = parseIntHeader(connection, "X-Rate-Limit-Retry-After-Seconds");
            InputStream stream = status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            String body = readStream(stream);

            if (status >= 200 && status < 300) {
                String filteredBody = query.isEmpty() ? body : filterSearchResults(body, query);
                sendSuccess(requestId, filteredBody, query, remaining);
            } else if (status == 429) {
                sendError(requestId, "OpenSky 今日查詢額度已用完", status, retryAfter);
            } else {
                sendError(requestId, "航班資料暫時無法取得", status, retryAfter);
            }
        } catch (Exception error) {
            sendError(requestId, "連線失敗，請稍後再試", -1, 0);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void fetchFlightDetails(String requestId, String icao24, String callsign) {
        if (BuildConfig.AIRLABS_API_KEY.isEmpty()) {
            sendFlightDetailError(requestId, "尚未設定 AirLabs API Key");
            return;
        }
        if (!isNetworkAvailable()) {
            sendFlightDetailError(requestId, "目前沒有網路連線");
            return;
        }

        String cacheKey = icao24 + "|" + callsign;
        CachedFlightDetail cached = flightDetailCache.get(cacheKey);
        if (cached != null && System.currentTimeMillis() - cached.savedAt < DETAIL_CACHE_TTL_MS) {
            sendFlightDetailSuccess(requestId, cached.payload);
            return;
        }

        try {
            JSONObject live = fetchAirLabsRecord(
                AIRLABS_FLIGHTS_ENDPOINT,
                icao24.isEmpty() ? "flight_icao" : "hex",
                icao24.isEmpty() ? callsign : icao24
            );
            String flightIcao = live == null ? callsign : live.optString("flight_icao", callsign);
            JSONObject schedule = flightIcao.isEmpty()
                ? null
                : fetchAirLabsRecord(AIRLABS_SCHEDULES_ENDPOINT, "flight_icao", flightIcao);

            JSONObject result = new JSONObject();
            result.put("live", live == null ? JSONObject.NULL : live);
            result.put("schedule", schedule == null ? JSONObject.NULL : schedule);
            String payload = result.toString();
            flightDetailCache.put(cacheKey, new CachedFlightDetail(payload));
            sendFlightDetailSuccess(requestId, payload);
        } catch (Exception error) {
            sendFlightDetailError(requestId, "AirLabs 詳細資料暫時無法取得");
        }
    }

    private JSONObject fetchAirLabsRecord(
        String endpoint,
        String filterName,
        String filterValue
    ) throws Exception {
        if (filterValue.isEmpty()) {
            return null;
        }
        String requestUrl = endpoint
            + "?" + filterName + "=" + URLEncoder.encode(filterValue, "UTF-8")
            + "&api_key=" + URLEncoder.encode(BuildConfig.AIRLABS_API_KEY, "UTF-8");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(requestUrl).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(18_000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", USER_AGENT);
            int status = connection.getResponseCode();
            String body = readStream(
                status >= 200 && status < 300
                    ? connection.getInputStream()
                    : connection.getErrorStream()
            );
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("AirLabs HTTP " + status);
            }
            JSONObject root = new JSONObject(body);
            JSONArray response = root.optJSONArray("response");
            return response == null || response.length() == 0
                ? null
                : response.optJSONObject(0);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void sendFlightDetailSuccess(String requestId, String payload) {
        runJavascript(
            "window.SkyTrack.receiveFlightDetails("
                + JSONObject.quote(requestId) + ","
                + JSONObject.quote(payload) + ")"
        );
    }

    private void sendFlightDetailError(String requestId, String message) {
        runJavascript(
            "window.SkyTrack.receiveFlightDetailError("
                + JSONObject.quote(requestId) + ","
                + JSONObject.quote(message) + ")"
        );
    }

    private void sendSuccess(String requestId, String body, String query, int remaining) {
        String script = "window.SkyTrack.receiveFlights("
            + JSONObject.quote(requestId) + ","
            + JSONObject.quote(body) + ","
            + JSONObject.quote(query) + ","
            + remaining + ")";
        runJavascript(script);
    }

    private void sendError(String requestId, String message, int status, int retryAfter) {
        String script = "window.SkyTrack.receiveError("
            + JSONObject.quote(requestId) + ","
            + JSONObject.quote(message) + ","
            + status + ","
            + retryAfter + ")";
        runJavascript(script);
    }

    private void runJavascript(String script) {
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private static String readStream(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(stream, StandardCharsets.UTF_8)
        )) {
            String line;
            while ((line = reader.readLine()) != null) {
                result.append(line);
            }
        }
        return result.toString();
    }

    private static int parseIntHeader(HttpURLConnection connection, String name) {
        try {
            String value = connection.getHeaderField(name);
            return value == null ? -1 : Integer.parseInt(value);
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }

    private static String filterSearchResults(String body, String query) throws Exception {
        JSONObject source = new JSONObject(body);
        JSONArray states = source.optJSONArray("states");
        JSONArray matches = new JSONArray();
        String needle = query.toUpperCase(Locale.US);

        if (states != null) {
            for (int index = 0; index < states.length(); index++) {
                JSONArray row = states.optJSONArray(index);
                if (row == null) {
                    continue;
                }
                String icao24 = row.optString(0, "").trim().toUpperCase(Locale.US);
                String callsign = row.optString(1, "").trim().toUpperCase(Locale.US);
                if (icao24.contains(needle) || callsign.contains(needle)) {
                    matches.put(row);
                }
            }
        }

        JSONObject result = new JSONObject();
        result.put("time", source.optLong("time"));
        result.put("states", matches);
        return result.toString();
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private static final class CachedFlightDetail {
        private final String payload;
        private final long savedAt;

        private CachedFlightDetail(String payload) {
            this.payload = payload;
            this.savedAt = System.currentTimeMillis();
        }
    }
}
