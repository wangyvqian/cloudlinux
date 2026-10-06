// CloudLinux 启动器（C# / WinForms，.NET Framework 4.x）
//
// 为什么用 WinForms：
//   目标机器是 Windows，而 C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
//   是系统自带的，编译这个启动器不需要额外下载任何 SDK —— 符合「零外部依赖」的取向。
//
// 职责：
//   · 找到并启动 cloudlinux-agent.exe（或源码模式下的 node）
//   · 托盘常驻 + 健康检查（轮询 /api/ping）
//   · 显示配对码（读便携目录里的 pairing-code.txt）
//   · 打开网页控制台 / 便携目录 / 日志
//   · 优雅停机
//
// 语言特性限制：Framework 自带的 csc 只支持到 C# 5，
// 所以这里不用字符串插值、不用 nameof、不用 ?. 运算符。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CloudLinuxLauncher
{
    internal static class Program
    {
        // 不声明 DPI 感知的话，高分屏上 Windows 会把窗口做位图缩放，
        // 结果就是发虚、尺寸不对（也就是“没有自缩放”的现象）。
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main(string[] args)
        {
            try { SetProcessDPIAware(); }
            catch { /* 老系统不支持就算了 */ }

            bool startMinimized = false;
            foreach (string a in args)
            {
                if (a == "--minimized" || a == "-m") startMinimized = true;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(startMinimized));
        }
    }

    /// <summary>启动器配置，存在 EXE 同级的 launcher.ini 里，纯文本 key=value。</summary>
    internal class LauncherConfig
    {
        public string ConsoleUrl = "https://wangyvqian.github.io/cloudlinux/";
        public int Port = 8765;
        public bool AutoStartAgent = true;

        public static LauncherConfig Load(string path)
        {
            LauncherConfig cfg = new LauncherConfig();
            try
            {
                if (!File.Exists(path)) return cfg;
                foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                    string val = line.Substring(eq + 1).Trim();
                    if (key == "consoleurl" && val.Length > 0) cfg.ConsoleUrl = val;
                    else if (key == "port")
                    {
                        int p;
                        if (int.TryParse(val, out p) && p > 0 && p < 65536) cfg.Port = p;
                    }
                    else if (key == "autostart")
                    {
                        cfg.AutoStartAgent = (val == "1" || val.ToLowerInvariant() == "true");
                    }
                }
            }
            catch { /* 配置读不了就用默认值 */ }
            return cfg;
        }
    }

    internal class MainForm : Form
    {
        private readonly LauncherConfig _cfg;
        private readonly string _baseDir;      // EXE 所在目录
        private readonly string _homeDir;      // 便携目录
        private readonly NotifyIcon _tray;

        private Process _agent;
        private System.Windows.Forms.Timer _poll;
        private bool _agentOnline;
        private bool _allowExit;
        private string _agentKind = "未找到";   // exe | source | 未找到

        // 控件
        private Label _statusLabel;
        private Panel _statusDot;
        private TextBox _logBox;
        private Label _pinLabel;
        private LinkLabel _urlLabel;
        private Button _btnStart;
        private Button _btnStop;
        private CheckBox _chkAuto;

        public MainForm(bool startMinimized)
        {
            _baseDir = Path.GetDirectoryName(Application.ExecutablePath);
            _homeDir = Path.Combine(_baseDir, "data");
            _cfg = LauncherConfig.Load(Path.Combine(_baseDir, "launcher.ini"));

            Text = "CloudLinux 启动器";
            ClientSize = new Size(660, 520);
            MinimumSize = new Size(560, 420);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(20, 26, 34);
            ForeColor = Color.FromArgb(230, 237, 243);

            BuildUi();
            DetectAgent();

            _tray = BuildTray();

            _poll = new System.Windows.Forms.Timer();
            _poll.Interval = 3000;
            _poll.Tick += delegate { Poll(); };
            _poll.Start();

            Shown += delegate
            {
                AppendLog("启动器已就绪。便携目录：" + _homeDir);
                AppendLog("助手程序：" + DescribeAgent());
                if (startMinimized) BeginInvoke(new Action(HideToTray));
                if (_cfg.AutoStartAgent) StartAgent(false);
                Poll();
            };

            FormClosing += delegate(object s, FormClosingEventArgs e)
            {
                // 点右上角关闭 = 收进托盘；真正退出走托盘菜单
                if (!_allowExit && e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    HideToTray();
                }
            };
        }

        /* ------------------------------ 界面 ------------------------------ */

        private void BuildUi()
        {
            // 顶部状态条
            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 74;
            header.BackColor = Color.FromArgb(15, 21, 28);
            header.Padding = new Padding(16, 12, 16, 12);
            Controls.Add(header);

            _statusDot = new Panel();
            _statusDot.Size = new Size(11, 11);
            _statusDot.Location = new Point(18, 30);
            _statusDot.BackColor = Color.FromArgb(110, 130, 150);
            header.Controls.Add(_statusDot);

            Label title = new Label();
            title.Text = "CloudLinux 桌面助手";
            title.Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(38, 14);
            header.Controls.Add(title);

            _statusLabel = new Label();
            _statusLabel.Text = "正在检测…";
            _statusLabel.AutoSize = true;
            _statusLabel.ForeColor = Color.FromArgb(160, 176, 192);
            _statusLabel.Location = new Point(38, 40);
            header.Controls.Add(_statusLabel);

            // 操作按钮
            FlowLayoutPanel actions = new FlowLayoutPanel();
            actions.Dock = DockStyle.Top;
            actions.Height = 52;
            actions.Padding = new Padding(12, 10, 12, 6);
            actions.BackColor = Color.FromArgb(20, 26, 34);
            Controls.Add(actions);
            actions.BringToFront();

            _btnStart = MakeButton("启动助手", delegate { StartAgent(true); });
            _btnStop = MakeButton("停止助手", delegate { StopAgent(true); });
            Button btnOpen = MakeButton("打开控制台", delegate { OpenConsole(); });
            Button btnFolder = MakeButton("便携目录", delegate { OpenFolder(); });
            Button btnLog = MakeButton("打开日志", delegate { OpenLogFile(); });
            Button btnPin = MakeButton("重置配对码", delegate { RotatePin(); });

            actions.Controls.Add(_btnStart);
            actions.Controls.Add(_btnStop);
            actions.Controls.Add(btnOpen);
            actions.Controls.Add(btnFolder);
            actions.Controls.Add(btnLog);
            actions.Controls.Add(btnPin);

            // 配对码提示（这块要醒目，用户第一次最需要看它）
            Panel pinPanel = new Panel();
            pinPanel.Dock = DockStyle.Top;
            pinPanel.Height = 58;
            pinPanel.Padding = new Padding(16, 6, 16, 6);
            Controls.Add(pinPanel);
            pinPanel.BringToFront();

            _pinLabel = new Label();
            _pinLabel.AutoSize = false;
            _pinLabel.Location = new Point(16, 8);
            _pinLabel.Size = new Size(360, 42);
            _pinLabel.TextAlign = ContentAlignment.MiddleLeft;
            _pinLabel.Font = new Font("Consolas", 13F, FontStyle.Bold);
            _pinLabel.ForeColor = Color.FromArgb(126, 201, 248);
            _pinLabel.BackColor = Color.FromArgb(24, 38, 52);
            _pinLabel.Text = "配对码：尚未生成";
            pinPanel.Controls.Add(_pinLabel);

            _urlLabel = new LinkLabel();
            _urlLabel.AutoSize = true;
            _urlLabel.Location = new Point(392, 18);
            _urlLabel.LinkColor = Color.FromArgb(126, 201, 248);
            _urlLabel.Text = "http://127.0.0.1:" + _cfg.Port;
            _urlLabel.Click += delegate { OpenConsole(); };
            pinPanel.Controls.Add(_urlLabel);

            // 日志区
            _logBox = new TextBox();
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.ScrollBars = ScrollBars.Vertical;
            _logBox.Dock = DockStyle.Fill;
            _logBox.BackColor = Color.FromArgb(10, 14, 18);
            _logBox.ForeColor = Color.FromArgb(195, 208, 220);
            _logBox.BorderStyle = BorderStyle.None;
            _logBox.Font = new Font("Consolas", 9F);
            _logBox.WordWrap = true;

            Panel logHost = new Panel();
            logHost.Dock = DockStyle.Fill;
            logHost.Padding = new Padding(16, 6, 16, 8);
            logHost.Controls.Add(_logBox);
            Controls.Add(logHost);
            logHost.BringToFront();

            // 底部选项
            Panel footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 44;
            footer.Padding = new Padding(16, 8, 16, 8);
            Controls.Add(footer);

            _chkAuto = new CheckBox();
            _chkAuto.Text = "启动时自动运行助手";
            _chkAuto.Checked = _cfg.AutoStartAgent;
            _chkAuto.AutoSize = true;
            _chkAuto.ForeColor = Color.FromArgb(160, 176, 192);
            _chkAuto.Location = new Point(16, 12);
            _chkAuto.CheckedChanged += delegate { SaveAutoStart(); };
            footer.Controls.Add(_chkAuto);

            Label tip = new Label();
            tip.Text = "关闭窗口会收进托盘，真正退出请右键托盘图标。";
            tip.AutoSize = true;
            tip.ForeColor = Color.FromArgb(110, 130, 150);
            tip.Location = new Point(230, 14);
            footer.Controls.Add(tip);
        }

        private Button MakeButton(string text, EventHandler onClick)
        {
            Button b = new Button();
            b.Text = text;
            b.AutoSize = true;
            b.Padding = new Padding(10, 4, 10, 4);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Color.FromArgb(38, 50, 63);
            b.BackColor = Color.FromArgb(34, 48, 64);
            b.ForeColor = Color.FromArgb(230, 237, 243);
            b.Margin = new Padding(0, 0, 8, 0);
            b.Click += onClick;
            return b;
        }

        private NotifyIcon BuildTray()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("打开面板", null, delegate { ShowPanel(); });
            menu.Items.Add("打开控制台", null, delegate { OpenConsole(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("启动助手", null, delegate { StartAgent(true); });
            menu.Items.Add("停止助手", null, delegate { StopAgent(true); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitApp(); });

            NotifyIcon tray = new NotifyIcon();
            tray.Icon = SystemIcons.Application;
            tray.Text = "CloudLinux 启动器";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.DoubleClick += delegate { ShowPanel(); };
            return tray;
        }

        private void HideToTray()
        {
            Hide();
            ShowInTaskbar = false;
            _tray.ShowBalloonTip(1500, "CloudLinux", "启动器已收进托盘，双击图标可重新打开。", ToolTipIcon.Info);
        }

        private void ShowPanel()
        {
            Show();
            ShowInTaskbar = true;
            WindowState = FormWindowState.Normal;
            Activate();
        }

        /* ------------------------------ 助手进程 ------------------------------ */

        /// <summary>找助手：优先用同目录的 cloudlinux-agent.exe，其次找源码 + node。</summary>
        private void DetectAgent()
        {
            string exePath = Path.Combine(_baseDir, "cloudlinux-agent.exe");
            if (File.Exists(exePath)) { _agentKind = "exe"; return; }

            string sourceEntry = Path.Combine(_baseDir, "agent", "src", "index.js");
            if (File.Exists(sourceEntry) && FindNode() != null) { _agentKind = "source"; return; }

            _agentKind = "未找到";
        }

        private string DescribeAgent()
        {
            if (_agentKind == "exe") return Path.Combine(_baseDir, "cloudlinux-agent.exe");
            if (_agentKind == "source") return "源码模式：" + Path.Combine(_baseDir, "agent", "src", "index.js");
            return "未找到（请把 cloudlinux-agent.exe 放到这里，或保留 agent/ 目录）";
        }

        private string FindNode()
        {
            // 先找同目录，再找常见安装位置，最后靠 PATH
            string local = Path.Combine(_baseDir, "node.exe");
            if (File.Exists(local)) return local;
            string[] guesses = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            };
            foreach (string g in guesses) { if (File.Exists(g)) return g; }
            return "node.exe"; // 交给 PATH
        }

        private void StartAgent(bool manual)
        {
            if (_agent != null && !_agent.HasExited)
            {
                if (manual) AppendLog("助手已经在运行了（PID " + _agent.Id + "）。");
                return;
            }

            DetectAgent();
            if (_agentKind == "未找到")
            {
                AppendLog("找不到助手程序：" + DescribeAgent());
                if (manual)
                {
                    MessageBox.Show(
                        "找不到助手程序。\r\n\r\n请把 cloudlinux-agent.exe 与启动器放在同一个目录，\r\n" +
                        "或者保留 agent\\ 源码目录（需要本机已安装 Node.js）。",
                        "CloudLinux", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                return;
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                // 让助手监视本启动器，本进程一退出它就优雅收工（而不是被硬杀）
                string parentArg = " --parent-pid " + Process.GetCurrentProcess().Id;
                if (_agentKind == "exe")
                {
                    psi.FileName = Path.Combine(_baseDir, "cloudlinux-agent.exe");
                    psi.Arguments = parentArg.TrimStart();
                }
                else
                {
                    psi.FileName = FindNode();
                    psi.Arguments = "\"" + Path.Combine(_baseDir, "agent", "src", "index.js") + "\"" + parentArg;
                }
                psi.WorkingDirectory = _baseDir;
                // 不弹黑窗口；日志靠便携目录里的日志文件看
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                // 助手输出的是 UTF-8。不指定就会按系统 ANSI（中文系统是 GBK）解码，
                // 中文会变成乱码。
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;

                _agent = new Process();
                _agent.StartInfo = psi;
                _agent.EnableRaisingEvents = true;

                // 后台把子进程输出读走，否则管道满了会卡住助手
                _agent.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (!String.IsNullOrEmpty(e.Data)) AppendLogThreadSafe(e.Data);
                };
                _agent.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (!String.IsNullOrEmpty(e.Data)) AppendLogThreadSafe(e.Data);
                };
                _agent.Exited += delegate
                {
                    AppendLogThreadSafe("--- 助手进程已退出（代码 " + _agent.ExitCode + "）---");
                };

                _agent.Start();
                _agent.BeginOutputReadLine();
                _agent.BeginErrorReadLine();
                AppendLog("已启动助手（PID " + _agent.Id + "）");
            }
            catch (Exception ex)
            {
                AppendLog("启动失败：" + ex.Message);
                if (manual)
                {
                    MessageBox.Show("启动助手失败：\r\n" + ex.Message, "CloudLinux",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private void StopAgent(bool manual)
        {
            if (_agent == null || _agent.HasExited)
            {
                if (manual) AppendLog("助手当前没有在运行。");
                return;
            }

            // 先试优雅停机：写一个请求文件，助手看到后会先关掉虚拟机再退出。
            // 直接 Kill 是硬终止，正在跑的虚拟机会被抡掉（有数据损坏风险）。
            try
            {
                Directory.CreateDirectory(_homeDir);
                File.WriteAllText(Path.Combine(_homeDir, "shutdown.request"),
                    DateTime.Now.ToString("o"), Encoding.UTF8);
                AppendLog("已发送优雅停机请求…");

                for (int i = 0; i < 30; i++)
                {
                    if (_agent.HasExited) { AppendLog("助手已优雅退出。"); return; }
                    Thread.Sleep(500);
                }
                AppendLog("等待超时（可能正在关闭虚拟机），将强制结束。");
            }
            catch (Exception ex)
            {
                AppendLog("发送停机请求失败：" + ex.Message);
            }

            try
            {
                if (!_agent.HasExited)
                {
                    _agent.Kill();
                    _agent.WaitForExit(8000);
                }
                AppendLog("已强制停止助手。");
            }
            catch (Exception ex)
            {
                AppendLog("停止失败：" + ex.Message);
            }
        }

        private void RotatePin()
        {
            DialogResult r = MessageBox.Show(
                "重置配对码会让所有已配对的设备失效。\r\n继续吗？",
                "CloudLinux", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;

            string exe;
            string arguments = "--new-pin";
            if (_agentKind == "exe") exe = Path.Combine(_baseDir, "cloudlinux-agent.exe");
            else if (_agentKind == "source") exe = FindNode();
            else { AppendLog("找不到助手程序，无法重置。"); return; }
            if (_agentKind == "source")
            {
                arguments = "\"" + Path.Combine(_baseDir, "agent", "src", "index.js") + "\" --new-pin";
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(exe, arguments);
                psi.WorkingDirectory = _baseDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                Process p = Process.Start(psi);
                p.WaitForExit(20000);
                string pin = ReadPinFile();
                if (pin != null)
                {
                    MessageBox.Show("新的配对码是：\r\n\r\n   " + pin +
                        "\r\n\r\n请在网页控制台里输入它。",
                        "配对码已重置", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    AppendLog("已重新生成配对码，但没能读到它。请检查助手是否能正常启动。");
                }
                // 如果助手正在运行，需要重启才能加载新码
                if (_agent != null && !_agent.HasExited)
                {
                    AppendLog("提示：助手正在运行，建议点「停止助手」再「启动助手」让新配对码生效。");
                }
                UpdatePinLabel();
            }
            catch (Exception ex)
            {
                AppendLog("重置配对码失败：" + ex.Message);
            }
        }

        /* ------------------------------ 健康检查 ------------------------------ */

        private void Poll()
        {
            bool online = PingAgent();
            if (online != _agentOnline)
            {
                _agentOnline = online;
                AppendLog(online ? "助手已就绪。" : "助手不可达。");
            }
            UpdateStatus(online);
            UpdatePinLabel();
        }

        private bool PingAgent()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + _cfg.Port + "/api/ping");
                req.Timeout = 1800;
                req.Method = "GET";
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private void UpdateStatus(bool online)
        {
            bool ours = (_agent != null && !_agent.HasExited);
            if (online)
            {
                _statusLabel.Text = ours
                    ? "助手运行中 · 监听 127.0.0.1:" + _cfg.Port
                    : "助手已在运行（由其他进程提供）· 监听 127.0.0.1:" + _cfg.Port;
                _statusLabel.ForeColor = Color.FromArgb(95, 220, 116);
                _statusDot.BackColor = Color.FromArgb(63, 185, 80);
            }
            else
            {
                _statusLabel.Text = ours ? "助手进程在跑，但还没响应（正在启动…）" : "助手未运行";
                _statusLabel.ForeColor = Color.FromArgb(232, 187, 96);
                _statusDot.BackColor = Color.FromArgb(217, 164, 65);
            }
            _btnStart.Enabled = !online;
            _btnStop.Enabled = ours;
            _tray.Text = "CloudLinux 启动器 — " + (online ? "运行中" : "已停止");
        }

        private void UpdatePinLabel()
        {
            string pin = ReadPinFile();
            if (pin == null)
            {
                if (_agentOnline) _pinLabel.Text = "配对码：（已配对，无需再输）";
                else _pinLabel.Text = "配对码：尚未生成（启动助手后出现）";
                _pinLabel.ForeColor = Color.FromArgb(140, 158, 176);
                return;
            }

            if (_agentOnline)
            {
                _pinLabel.Text = "配对码：" + pin + "（若已配对过则无需再输）";
                _pinLabel.ForeColor = Color.FromArgb(140, 158, 176);
            }
            else
            {
                _pinLabel.Text = "配对码：" + pin;
                _pinLabel.ForeColor = Color.FromArgb(126, 201, 248);
            }
        }

        /// <summary>
        /// 读出当前配对码。
        /// 先看 pairing-code.txt；读不到就去日志里找（助手启动时也会把配对码打进去）。
        /// 这样就算文件被删了，也能在界面里看到。
        /// </summary>
        private string ReadPinFile()
        {
            string fromFile = ReadPinFromCodeFile();
            if (fromFile != null) return fromFile;
            return ReadPinFromLog();
        }

        private string ReadPinFromCodeFile()
        {
            try
            {
                string file = Path.Combine(_homeDir, "pairing-code.txt");
                if (!File.Exists(file)) return null;
                return ExtractPin(File.ReadAllLines(file, Encoding.UTF8));
            }
            catch { /* ignore */ }
            return null;
        }

        /// <summary>从日志末尾找最后一次出现的配对码。</summary>
        private string ReadPinFromLog()
        {
            try
            {
                string log = Path.Combine(_homeDir, "logs", "agent.log");
                if (!File.Exists(log)) return null;

                // 日志可能很大，只读尾部；从后往前找第一次命中
                string tail = ReadTail(log, 64 * 1024);
                string[] lines = tail.Split(new char[] { '\n', '\r' });
                for (int i = lines.Length - 1; i >= 0; i--)
                {
                    string pin = ExtractPin(new string[] { lines[i] });
                    if (pin != null) return pin;
                }
            }
            catch { /* ignore */ }
            return null;
        }

        private static string ReadTail(string path, int maxBytes)
        {
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                long len = fs.Length;
                long start = len > maxBytes ? len - maxBytes : 0;
                fs.Seek(start, SeekOrigin.Begin);
                byte[] buf = new byte[len - start];
                int read = fs.Read(buf, 0, buf.Length);
                return Encoding.UTF8.GetString(buf, 0, read);
            }
        }

        /// <summary>从一行文本里抽出配对码（形如“配对码：ABCDEF”）。</summary>
        private static string ExtractPin(string[] lines)
        {
            foreach (string line in lines)
            {
                int idx = line.IndexOf("配对码");
                if (idx < 0) continue;
                int colon = line.IndexOfAny(new char[] { '：', ':' }, idx);
                if (colon < 0) continue;
                string rest = line.Substring(colon + 1).Trim();
                StringBuilder sb = new StringBuilder();
                foreach (char c in rest)
                {
                    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) sb.Append(c);
                    else break; // 配对码是大写字母+数字，遇到别的就停
                }
                if (sb.Length >= 4 && sb.Length <= 12) return sb.ToString();
            }
            return null;
        }

        /* ------------------------------ 外部动作 ------------------------------ */

        private void OpenConsole()
        {
            try
            {
                Process.Start(new ProcessStartInfo(_cfg.ConsoleUrl) { UseShellExecute = true });
                AppendLog("已在默认浏览器打开控制台：" + _cfg.ConsoleUrl);
            }
            catch (Exception ex)
            {
                AppendLog("打开控制台失败：" + ex.Message);
            }
        }

        private void OpenFolder()
        {
            try
            {
                Directory.CreateDirectory(_homeDir);
                Process.Start("explorer.exe", "\"" + _homeDir + "\"");
            }
            catch (Exception ex)
            {
                AppendLog("打开目录失败：" + ex.Message);
            }
        }

        private void OpenLogFile()
        {
            try
            {
                string log = Path.Combine(_homeDir, "logs", "agent.log");
                if (File.Exists(log)) Process.Start("notepad.exe", "\"" + log + "\"");
                else
                {
                    AppendLog("还没有日志文件（助手启动后才会生成）。");
                    OpenFolder();
                }
            }
            catch (Exception ex)
            {
                AppendLog("打开日志失败：" + ex.Message);
            }
        }

        private void SaveAutoStart()
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("# CloudLinux 启动器配置");
                sb.AppendLine("consoleUrl=" + _cfg.ConsoleUrl);
                sb.AppendLine("port=" + _cfg.Port);
                sb.AppendLine("autoStart=" + (_chkAuto.Checked ? "1" : "0"));
                File.WriteAllText(Path.Combine(_baseDir, "launcher.ini"), sb.ToString(), Encoding.UTF8);
                _cfg.AutoStartAgent = _chkAuto.Checked;
            }
            catch { /* 写不了就算了 */ }
        }

        private void ExitApp()
        {
            DialogResult r = MessageBox.Show(
                "退出会同时停止正在运行的助手（虚拟机也会被优雅关闭）。\r\n确定退出吗？",
                "CloudLinux", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;

            _allowExit = true;
            _poll.Stop();
            StopAgent(false);
            _tray.Visible = false;
            Application.Exit();
        }

        /* ------------------------------ 日志显示 ------------------------------ */

        private void AppendLog(string text)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(AppendLog), text); return; }
            string stamp = DateTime.Now.ToString("HH:mm:ss");
            _logBox.AppendText("[" + stamp + "] " + text + Environment.NewLine);
            if (_logBox.Lines.Length > 500)
            {
                // 太长就截掉前面一半，避免越来越吃内存
                string[] lines = _logBox.Lines;
                string[] keep = new string[lines.Length / 2];
                Array.Copy(lines, lines.Length / 2, keep, 0, keep.Length);
                _logBox.Lines = keep;
            }
            _logBox.SelectionStart = _logBox.TextLength;
            _logBox.ScrollToCaret();
        }

        private void AppendLogThreadSafe(string text)
        {
            try { BeginInvoke(new Action<string>(AppendLog), text); }
            catch { /* 窗口已销毁 */ }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_poll != null) _poll.Dispose();
                if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
            }
            base.Dispose(disposing);
        }
    }
}
