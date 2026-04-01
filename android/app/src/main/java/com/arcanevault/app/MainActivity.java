package com.arcanevault.app;

import android.graphics.Color;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.widget.Toast;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private long lastBackPressTime = 0;
    private Toast exitToast;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Transparent WebView background so CameraPreview shows behind the React UI
        this.bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);
        hideSystemBars();
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
        if (this.bridge != null && this.bridge.getWebView() != null) {
            // First prefer the native WebView back stack when it exists.
            if (this.bridge.getWebView().canGoBack()) {
                this.bridge.getWebView().goBack();
                return;
            }

            // BrowserRouter uses pushState, which does not always register as WebView history.
            // Query the current SPA route and use the browser history stack when we're not on root.
            this.bridge.getWebView().evaluateJavascript(
                "(function(){try{return window.location.pathname || '/';}catch(e){return '/';}})();",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        String path = normalizeJsString(value);
                        if (shouldNavigateInApp(path)) {
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

    private boolean shouldNavigateInApp(String path) {
        if (path == null || path.isEmpty()) return false;
        return !"/".equals(path)
            && !"/arcanevault".equals(path)
            && !"/arcanevault/".equals(path)
            && !"/login".equals(path);
    }

    private String normalizeJsString(String value) {
        if (value == null) return "/";
        String trimmed = value.trim();
        if (trimmed.length() >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            trimmed = trimmed.substring(1, trimmed.length() - 1);
        }
        return trimmed.replace("\\/", "/");
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
}
