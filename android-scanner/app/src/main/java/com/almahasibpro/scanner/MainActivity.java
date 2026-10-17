package com.almahasibpro.scanner;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.common.InputImage;
import org.json.JSONObject;
import java.io.OutputStream;
import java.io.InputStream;
import java.util.UUID;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {
    private static final int CAMERA_REQUEST = 100;
    private final ExecutorService cameraExecutor = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService networkExecutor = Executors.newSingleThreadScheduledExecutor();
    private BarcodeScanner scanner;
    private ProcessCameraProvider cameraProvider;
    private EditText tokenInput;
    private TextView status;
    private Button connect;
    private volatile String pairingToken = "";
    private String lastBarcode = "";
    private volatile String serverOrigin = "https://almahasibpro.onrender.com";
    private long lastScanAt;
    private volatile String pendingBarcode = "", pendingRequestId = "";
    private volatile boolean sending, destroyed, pairMode, validating;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        tokenInput = findViewById(R.id.tokenInput);
        String savedOrigin = getPreferences(MODE_PRIVATE).getString("serverOrigin", serverOrigin);
        if (PairingTarget.parse(savedOrigin + "/market-scanner.html#" + "00000000000000000000000000000000") != null) serverOrigin = savedOrigin;
        status = findViewById(R.id.statusText);
        connect = findViewById(R.id.connectButton);
        scanner = BarcodeScanning.getClient();
        connect.setOnClickListener(v -> {
            if (!pendingBarcode.isEmpty()) { send(pendingBarcode); return; }
            String token = tokenInput.getText().toString().trim();
            PairingTarget target = PairingTarget.parse(token);
            if (target != null) { serverOrigin = target.origin; token = target.token; }
            if (!token.matches("([a-fA-F0-9]{32}|[0-9]{6})")) { show("أدخل رمز الربط أو امسح QR من الكاشير"); return; }
            verifyPairing(token);
        });
        findViewById(R.id.qrPairButton).setOnClickListener(v -> {
            if (validating) return;
            if (!pendingBarcode.isEmpty()) { show("أعد إرسال المسح المعلّق قبل تغيير الكاشير"); return; }
            pairMode = true;
            openCamera();
        });
        networkExecutor.scheduleWithFixedDelay(this::heartbeat, 5, 5, TimeUnit.SECONDS);
    }

    private void heartbeat() {
        if (destroyed || validating || pairMode || pairingToken.isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            connection = openConnection(serverOrigin + "/api/v1/market/scanner/" + pairingToken + "/status");
            int code = connection.getResponseCode();
            if (code == 410) { pairingToken = ""; show("تم فصل الهاتف من الكاشير؛ امسح QR جديداً"); }
        } catch (Exception error) { show("انقطع الاتصال المحلي؛ تجري إعادة المحاولة"); }
        finally { if (connection != null) connection.disconnect(); }
    }

    private HttpURLConnection openConnection(String address) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
        return connection;
    }

    private void openCamera() {
        ((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE))
            .hideSoftInputFromWindow(tokenInput.getWindowToken(), 0);
        tokenInput.clearFocus();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
        else startCamera();
    }

    private void verifyPairing(String token) {
        if (destroyed || validating) return;
        validating = true;
        show("جارٍ التحقق من الربط…");
        networkExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String resolvedToken = token;
                if (token.matches("[0-9]{6}")) {
                    connection = openConnection(serverOrigin + "/api/v1/market/scanner/code/resolve");
                    connection.setRequestMethod("POST"); connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                    try (OutputStream output = connection.getOutputStream()) { output.write(new JSONObject().put("code",token).toString().getBytes(StandardCharsets.UTF_8)); }
                    int result = connection.getResponseCode();
                    if (result != 200) { show(result == 429 ? "محاولات كثيرة؛ انتظر ثم حاول مجدداً" : "رمز الاقتران غير صالح أو منتهي (" + result + ")"); return; }
                    try (InputStream input = connection.getInputStream()) {
                        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                        byte[] buffer = new byte[1024]; int count;
                        while ((count = input.read(buffer)) != -1) { bytes.write(buffer,0,count); if (bytes.size()>4096) throw new java.io.IOException("Invalid pairing response"); }
                        resolvedToken = new JSONObject(bytes.toString("UTF-8")).getString("token");
                    }
                    connection.disconnect();
                }
                if (!resolvedToken.matches("[a-fA-F0-9]{32}")) throw new java.io.IOException("Invalid pairing token");
                final String verifiedToken = resolvedToken;
                connection = openConnection(serverOrigin + "/api/v1/market/scanner/" + verifiedToken + "/status");
                int code = connection.getResponseCode();
                runOnUiThread(() -> {
                    if (destroyed) return;
                    if (code == 200) {
                        pairingToken = verifiedToken; tokenInput.setText(verifiedToken); pairMode = false;
                        getPreferences(MODE_PRIVATE).edit().putString("serverOrigin", serverOrigin).apply();
                        lastBarcode = ""; lastScanAt = 0;
                        openCamera();
                    } else if (code == 410) show("رمز الربط انتهى. أنشئ QR جديدًا من الكاشير.");
                    else if (code == 403) show("رفض الكاشير الاتصال؛ تحقق من تفعيل ترخيص الشبكة على الحاسوب");
                    else show("تعذر التحقق من الربط (" + code + "). حاول مرة أخرى.");
                });
            } catch (Exception e) { show("تعذر الوصول للكاشير؛ وصّل الهاتف والحاسوب بالشبكة نفسها وتحقق من جدار حماية Windows."); }
            finally { if (connection != null) connection.disconnect(); validating = false; }
        });
    }

    private String pairingQrToken(String value) {
        PairingTarget target = PairingTarget.parse(value);
        if (target == null) return null;
        if (pairMode) serverOrigin = target.origin;
        return target.token;
    }

    @Override public void onRequestPermissionsResult(int request, @NonNull String[] permissions, @NonNull int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == CAMERA_REQUEST) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startCamera();
            else show("إذن الكاميرا مطلوب للمسح. اسمح به ثم اضغط تشغيل القارئ.");
        }
    }

    @androidx.annotation.OptIn(markerClass = androidx.camera.core.ExperimentalGetImage.class)
    private void startCamera() {
        connect.setEnabled(false);
        show("جارٍ تشغيل الكاميرا…");
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            if (destroyed) return;
            try {
                cameraProvider = future.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(((PreviewView)findViewById(R.id.preview)).getSurfaceProvider());
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                analysis.setAnalyzer(cameraExecutor, image -> {
                    if (destroyed || sending || validating || image.getImage() == null) { image.close(); return; }
                    InputImage input = InputImage.fromMediaImage(image.getImage(), image.getImageInfo().getRotationDegrees());
                    try {
                        scanner.process(input).addOnSuccessListener(barcodes -> {
                            if (destroyed || sending || validating || barcodes.isEmpty()) return;
                            String value = barcodes.get(0).getRawValue();
                            if (pairMode) {
                                if (barcodes.get(0).getFormat() != com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE) return;
                                String token = pairingQrToken(value);
                                if (token != null) verifyPairing(token);
                                else show("امسح QR الربط الظاهر في شاشة الكاشير");
                                return;
                            }
                            if (pairingQrToken(value) != null) return;
                            long now = android.os.SystemClock.elapsedRealtime();
                            if (value != null && !value.isEmpty() && (!value.equals(lastBarcode) || now-lastScanAt > 1800)) {
                                lastBarcode = value; lastScanAt = now; send(value);
                            }
                        }).addOnFailureListener(e -> show("تعذرت قراءة الباركود، حاول مرة أخرى"))
                          .addOnCompleteListener(task -> image.close());
                    } catch (Exception e) { image.close(); show("تعذرت قراءة الصورة"); }
                });
                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis);
                show(pairMode ? "وجّه الكاميرا إلى QR الربط في شاشة الكاشير" : "تم الربط — جاهز لمسح باركود المواد");
            } catch (Exception e) { show("تعذر تشغيل الكاميرا. تحقق من الصلاحية وأغلق أي تطبيق يستخدمها."); }
            connect.setEnabled(true);
        }, ContextCompat.getMainExecutor(this));
    }

    private void send(String barcode) {
        if (sending || destroyed || pairMode || validating || pairingToken.isEmpty()) return;
        if (!pendingBarcode.isEmpty() && !pendingBarcode.equals(barcode)) { show("مسح سابق بانتظار الإرسال؛ اضغط ربط وتشغيل لإعادة إرساله"); return; }
        if (pendingBarcode.isEmpty()) { pendingBarcode = barcode; pendingRequestId = UUID.randomUUID().toString(); }
        final String requestId = pendingRequestId;
        sending = true;
        final String token = pairingToken;
        networkExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(serverOrigin + "/api/v1/market/scanner/" + URLEncoder.encode(token, "UTF-8") + "/scan");
                connection = openConnection(url.toString());
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                byte[] body = new JSONObject().put("barcode", barcode).put("request_id", requestId).toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int code = connection.getResponseCode();
                if (code >= 200 && code < 300) { pendingBarcode = ""; pendingRequestId = ""; flashResult(true, "تم الإرسال — جاهز للمسح"); }
                else if (code == 401 || code == 403 || code == 404 || code == 410) flashResult(false, "رمز الربط غير صالح أو انتهت صلاحيته. أنشئ رمزًا جديدًا من الكاشير.");
                else flashResult(false, "تعذر إرسال الباركود (" + code + "). حاول مرة أخرى.");
            } catch (Exception e) { flashResult(false, "انقطع الاتصال المحلي؛ أعد مسح المادة نفسها أو اضغط ربط وتشغيل لإعادة الإرسال دون تكرار."); }
            finally { if (connection != null) connection.disconnect(); sending = false; }
        });
    }

    private void flashResult(boolean success, String message) {
        runOnUiThread(() -> {
            if (destroyed) return;
            status.setText(message);
            status.setTextColor(android.graphics.Color.parseColor(success ? "#53E39A" : "#FF7189"));
            android.view.View flash = findViewById(R.id.scanFlash);
            flash.animate().cancel();
            flash.setBackgroundColor(android.graphics.Color.parseColor(success ? "#8830D998" : "#99FF3855"));
            flash.setAlpha(1f);
            flash.setVisibility(android.view.View.VISIBLE);
            flash.animate().alpha(0f).setDuration(350).withEndAction(() -> {
                if (!destroyed) flash.setVisibility(android.view.View.GONE);
            }).start();
        });
    }

    private void show(String message) { runOnUiThread(() -> { if (!destroyed) status.setText(message); }); }

    @Override public void onDestroy() {
        destroyed = true;
        if (cameraProvider != null) cameraProvider.unbindAll();
        if (scanner != null) scanner.close();
        cameraExecutor.shutdown(); networkExecutor.shutdown();
        super.onDestroy();
    }
}

