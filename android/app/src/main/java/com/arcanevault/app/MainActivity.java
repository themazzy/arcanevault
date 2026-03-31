package com.arcanevault.app;

import android.graphics.Color;
import android.os.Bundle;
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
        // If the WebView has history (SPA navigated away from root), go back
        if (this.bridge != null
                && this.bridge.getWebView() != null
                && this.bridge.getWebView().canGoBack()) {
            this.bridge.getWebView().goBack();
            return;
        }

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
