package com.arcanevault.app;

import android.graphics.Color;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private long lastBackPressTime = 0;
    private Toast exitToast;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Transparent WebView background so CameraPreview shows behind the React UI
        this.bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);
        hideSystemBars();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBackPressed();
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
            new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
    }

    @Override
    public void onBackPressed() {
        handleBackPressed();
    }

    private void handleBackPressed() {
        if (this.bridge != null && this.bridge.getWebView() != null) {
            // First prefer the native WebView back stack when it exists.
            if (this.bridge.getWebView().canGoBack()) {
                this.bridge.getWebView().goBack();
                return;
            }

            // BrowserRouter uses pushState, which does not always register as WebView history.
            // Query both the current route and history length, then use browser history when appropriate.
            this.bridge.getWebView().evaluateJavascript(
                "(function(){try{return JSON.stringify({pathname: window.location.pathname || '/', historyLength: window.history.length || 0});}catch(e){return JSON.stringify({pathname:'/', historyLength:0});}})();",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        RouteState state = parseRouteState(value);
                        if (shouldNavigateInApp(state)) {
                            bridge.getWebView().evaluateJavascript("window.history.back();", null);
                        } else {
                            handleExitBackPress();
                        }
                    }
                }
            );
            return;
        }

        handleExitBackPress();
    }

    private boolean shouldNavigateInApp(RouteState state) {
        if (state == null) return false;
        if (state.historyLength > 1) return true;

        String path = state.pathname;
        if (path == null || path.isEmpty()) return false;
        return !"/".equals(path)
            && !"/arcanevault".equals(path)
            && !"/arcanevault/".equals(path)
            && !"/login".equals(path);
    }

    private RouteState parseRouteState(String value) {
        try {
            String normalized = normalizeJsString(value);
            JSONObject json = new JSONObject(normalized);
            String pathname = json.optString("pathname", "/");
            int historyLength = json.optInt("historyLength", 0);
            return new RouteState(pathname, historyLength);
        } catch (Exception ignored) {
            return new RouteState("/", 0);
        }
    }

    private String normalizeJsString(String value) {
        if (value == null) return "{\"pathname\":\"/\",\"historyLength\":0}";
        String trimmed = value.trim();
        if (trimmed.length() >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            trimmed = trimmed.substring(1, trimmed.length() - 1);
        }
        return trimmed
            .replace("\\\"", "\"")
            .replace("\\/", "/")
            .replace("\\n", "\n")
            .replace("\\t", "\t");
    }

    private void handleExitBackPress() {
        // No history — require double-tap within 2 s to exit
        long now = System.currentTimeMillis();
        if (now - lastBackPressTime < 2000) {
            // Cancel the pending toast so it doesn't linger after exit
            if (exitToast != null) exitToast.cancel();
            super.onBackPressed();
        } else {
            lastBackPressTime = now;
            if (exitToast != null) exitToast.cancel();
            exitToast = Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT);
            exitToast.show();
        }
    }

    private static class RouteState {
        final String pathname;
        final int historyLength;

        RouteState(String pathname, int historyLength) {
            this.pathname = pathname;
            this.historyLength = historyLength;
        }
    }
}
